// src/session/viewmodel.ts — 事件 → 渲染条目（视图模型）+ shadow 折叠
// 依据 docs/api/remote-mux.md §4.3~4.5：assistant/message 与 user/message 是主渲染，
// assistant/chunk 是流式增量，sourceEventSeqs 表示被覆盖（编辑重发）的旧事件需折叠。
// 设计取舍（text-first）：Lite 只维护「可读条目序列」，不做官方 MutableSessionEventSource
// 的全量窗口——形状用 events.ts 防御式解析，未知事件折叠为状态行，保证不炸 UI。
import { statusLineOf, textOf, toolCallText, type RawEvent, type SnapshotEvent } from './events';
import type { GoalBrief, GoalPhase } from '../model';

export type ViewEntryKind = 'user' | 'assistant' | 'tool' | 'command' | 'status';

export interface ViewEntry {
  seq: number;
  kind: ViewEntryKind;
  /** 对 UI 的 role 映射：user/assistant → 对应，其余 system */
  text: string;
  streaming?: boolean;
  /** tool 条目附带 */
  name?: string;
  toolState?: 'call' | 'result';
  /** command 条目附带（M6b：command/run↔command/done 按 commandId 配对） */
  commandId?: string;
  cmdState?: 'run' | 'done';
  cmdOk?: boolean;
  resultText?: string;
  ts?: number;
}

export interface ViewModelState {
  entries: ViewEntry[];
  /** 最新已处理的 seq（去重/调试用） */
  lastSeq: number;
}

const label = (s: string): string => {
  const seg = s.split('/');
  return seg[seg.length - 1] ?? s;
};

/** tool/result 文本存储上限（M4 §2.1；UI 侧折叠展示，存储全文无必要） */
const TOOL_RESULT_CAP = 2000;

/**
 * 静默前缀：这些事件对聊天无意义（会话生命周期/子代理/团队/钩子/网络请求等内部噪音），
 * 推进 seq 但不产生渲染条目。类型全集以 0.1.2-rc.1 known-event-types.js 实证为准。
 */
const SILENT_PREFIXES = ['session/', 'subagent/', 'team/', 'hook/', 'request/', 'web/'];

export class SessionViewModel {
  private entries: ViewEntry[] = [];
  private seenSeqs = new Set<number>();
  private lastSeq = 0;
  private goal: GoalBrief | null = null;
  private listeners = new Set<() => void>();

  getState(): ViewModelState {
    return { entries: this.entries.slice(), lastSeq: this.lastSeq };
  }

  /** 当前目标投影（M6d：由 goal/change 整快照折叠；无目标/已 clear → null） */
  getGoal(): GoalBrief | null {
    return this.goal ? { ...this.goal } : null;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  private push(e: ViewEntry): void {
    this.entries.push(e);
  }

  private dropSeqs(seqs: Iterable<number>): void {
    const drop = new Set(seqs);
    if (drop.size === 0) return;
    this.entries = this.entries.filter((e) => !drop.has(e.seq));
  }

  /** 当前打开的流式助手条目（chunk 累积目标） */
  private openAssistantTail(): ViewEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.kind === 'assistant') return e;
      if (e.kind === 'user') return null; // 越过当前回合边界
    }
    return null;
  }

  /** 找最近一条仍处于 run 态的 command 条目（command/done 的配对目标） */
  private findOpenCommand(commandId: string): ViewEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.kind !== 'command') continue;
      if (e.cmdState === 'run' && (commandId === '' || e.commandId === commandId)) return e;
      return null; // 越过最近一条 command 后不再回看（避免配错更早的同类命令）
    }
    return null;
  }

  /** M6d：折叠 goal/change 整快照 → this.goal。clear 为墓碑；数据异常时保守不动。 */
  private foldGoal(data: unknown): void {
    const d = asRecord(data);
    if (!d) return;
    if (d['operation'] === 'clear') {
      this.goal = null;
      return;
    }
    const g = asRecord(d['goal']);
    if (!g) return;
    const id = strOf(g['id']);
    if (!id) return;
    const phaseRaw = strOf(g['phase']);
    const phase: GoalPhase =
      phaseRaw === 'active' || phaseRaw === 'paused' || phaseRaw === 'blocked' || phaseRaw === 'complete'
        ? phaseRaw
        : 'active';
    const blocked = asRecord(g['blockedReason']);
    this.goal = {
      id,
      revision: numOf(g['revision']) ?? 0,
      objective: strOf(g['objective']),
      phase,
      maxGoalRounds: numOf(g['maxGoalRounds']) ?? 0,
      ...(blocked && typeof blocked['code'] === 'string' && typeof blocked['message'] === 'string'
        ? { blockedReason: { code: blocked['code'], message: blocked['message'] } }
        : {}),
      roundsStarted: numOf(d['roundsStarted']) ?? 0,
      createdAt: numOf(d['createdAt']) ?? 0,
      updatedAt: numOf(d['updatedAt']) ?? 0,
    };
  }

  /** 应用 follow 的快照记录（records[]）；返回首个可用 seq */
  applyRecords(records: { type: string; event?: RawEvent; seq?: number }[] | undefined): void {
    if (!Array.isArray(records)) return;
    for (const rec of records) {
      if (rec.event) this.applyEvent(rec.event);
    }
    this.emit();
  }

  /** 应用一条事件（snapshot 之后到达的增量）。返回是否被 UI 采纳（跳过 ignorable 与内部事件）。 */
  applyEvent(evt: RawEvent): boolean {
    if (!evt || typeof evt.seq !== 'number') return false;
    if (this.seenSeqs.has(evt.seq)) return false; // 幂等
    this.seenSeqs.add(evt.seq);
    if (evt.seq > this.lastSeq) this.lastSeq = evt.seq;
    if (evt.ignorable) return false;

    const ts = evt.time;
    const seq = evt.seq;
    const data = evt.data;

    // shadow 折叠：sourceEventSeqs 列出被本事件覆盖的旧事件（编辑重发/压缩替换）
    if (Array.isArray(evt.sourceEventSeqs) && evt.sourceEventSeqs.length > 0) {
      this.dropSeqs(evt.sourceEventSeqs.map(Number).filter((n) => Number.isFinite(n)));
    }
    const surface = evt.surfaceOp as { op?: string } | undefined;
    if (surface && typeof surface === 'object' && surface.op === 'replace') {
      // replace 的 start/end 语义在不同版本里可能是 seq 也可能是窗口下标，Lite 只依赖
      // sourceEventSeqs 折叠，raw replace 仅记录，不冒险大范围删除。
    }

    const t = evt.type;
    if (t === 'user/message' || t === 'assistant/message') {
      const kind = t === 'user/message' ? 'user' : 'assistant';
      const txt = textOf(data);
      // assistant/message 常作为「定稿」：若已有同一回合的流式尾巴且其文本是该消息的前缀，
      // 直接升级尾巴（避免 chunk 累积 + 最终消息重复渲染）
      if (kind === 'assistant' && txt) {
        const tail = this.openAssistantTail();
        if (tail && tail.streaming && (tail.text === '' || txt.startsWith(tail.text))) {
          tail.text = txt;
          tail.streaming = false;
          this.emit();
          return true;
        }
        if (tail && tail.streaming) tail.streaming = false;
      }
      this.push({ seq, kind, text: txt, ts });
      this.emit();
      return true;
    }
    if (t === 'assistant/chunk') {
      const part = textOf(data);
      const tail = this.openAssistantTail();
      if (tail && tail.kind === 'assistant' && tail.streaming !== false) {
        tail.streaming = true;
        if (part && !tail.text.endsWith(part)) tail.text += part;
      } else if (part) {
        // 没有开放的助手消息时（快照没带上之前的）也允许创建流式占位
        this.push({ seq, kind: 'assistant', text: part, streaming: true, ts });
      }
      this.emit();
      return true;
    }
    if (t === 'tool/call') {
      const txt = toolCallText(data);
      this.push({ seq, kind: 'tool', name: txt.split('(')[0] ?? txt, text: txt, toolState: 'call', ts });
      this.emit();
      return true;
    }
    if (t === 'tool/result') {
      const txt = textOf(data);
      // M4 §2.1：上限 2000 字，防大结果每次下发撑爆 postMessage
      const short = txt.length > TOOL_RESULT_CAP ? `${txt.slice(0, TOOL_RESULT_CAP)}…(已截断)` : txt;
      this.push({ seq, kind: 'tool', name: label(t), text: short, toolState: 'result', ts });
      this.emit();
      return true;
    }
    // M6b：斜杠命令生命周期。command/run 记录命令，command/done 按 commandId 配对更新
    if (t === 'command/run') {
      const d = asRecord(data);
      const name = d ? strOf(d['name']) : '';
      const args = d && typeof d['args'] === 'string' ? d['args'].trim() : '';
      const commandId = d ? strOf(d['commandId']) : '';
      const line = name ? `/${name}${args ? ` ${args}` : ''}` : textOf(data);
      this.push({ seq, kind: 'command', text: line, name: name || undefined, commandId, cmdState: 'run', ts });
      this.emit();
      return true;
    }
    if (t === 'command/done') {
      const d = asRecord(data);
      const commandId = d ? strOf(d['commandId']) : '';
      const ok = d ? d['kind'] === 'success' : false;
      const resultText = d && typeof d['text'] === 'string' ? d['text'] : undefined;
      const target = this.findOpenCommand(commandId);
      if (target) {
        target.cmdState = 'done';
        target.cmdOk = ok;
        if (resultText) target.resultText = resultText;
      } else {
        this.push({
          seq,
          kind: 'command',
          text: commandId ? `命令 ${commandId}` : '命令完成',
          commandId,
          cmdState: 'done',
          cmdOk: ok,
          ...(resultText ? { resultText } : {}),
          ts,
        });
      }
      this.emit();
      return true;
    }
    if (t === 'goal/change') {
      // M6d：goal/change 是整快照（最新一条即当前态；clear 为墓碑）——折叠进 goal 投影。
      // 不落状态行：它在目标周期内高频推送，落行会把消息流刷成「目标已更新」墙；
      // 当前态由 goal dock 展示，故折叠后直接返回（emit 让 dock 刷新）。
      this.foldGoal(data);
      this.emit();
      return false;
    }
    const status = statusLineOf(t);
    if (status) {
      this.push({ seq, kind: 'status', text: status, ts });
      this.emit();
      return true;
    }
    // 静默前缀：会话生命周期 / 子代理 / 团队 / 钩子 / 请求 / 网络内部事件不渲染（见 SILENT_PREFIXES）
    for (const p of SILENT_PREFIXES) {
      if (t.startsWith(p)) return false;
    }
    // 未识别事件：折叠为简短状态行，避免整条 JSON 糊在聊天里
    this.push({ seq, kind: 'status', text: label(t), ts });
    this.emit();
    return true;
  }

  /** 快照整体替换（切换会话/重连时用） */
  reset(): void {
    this.entries = [];
    this.seenSeqs.clear();
    this.lastSeq = 0;
    this.goal = null;
    this.emit();
  }
}

/** 防御式字段读取（事件 data 均来自线缆，形状随版本演化，取不到就回退默认） */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function strOf(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function numOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 兼容 SnapshotEvent 导入（供测试使用类型） */
export type { SnapshotEvent };
