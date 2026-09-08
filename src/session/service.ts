// src/session/service.ts — 会话编排：选中会话 + follow 订阅 + 发送/停止/新建
// + M6：斜杠命令分流（submit 首字符 '/'）+ 命令目录拉取 + $events 审批应答 + 目标动作
// 对外给 provider（provider 合成 PanelState 下发，UI 只渲染）。
import type { ConnectionManager, LiteSnapshot } from '../connection';
import type {
  ApprovalView,
  CommandRow,
  GoalBrief,
  ViewMessage,
} from '../model';
import type { GoalRef } from './goals';
import { mutateGoal } from './goals';
import { listCommands, runCommand, type CommandApiDeps } from './commands';
import { RemoteEventsHub, type ApprovalOutcome, type PendingApprovalRequest } from './events-stream';
import { SessionController } from './controller';
import { cancelSession, createSession, promptSession } from './api';
import type { ViewEntry } from './viewmodel';

export interface SessionServiceDeps {
  log: (line: string) => void;
  /** 新建会话的 cwd（工作区根） */
  workspaceRoot?: string;
  /** 运行中再次发送：queue=排队 / steer=跟进 */
  followUpMode: 'queue' | 'steer';
}

/** 斜杠目录的宿主态：undefined=未拉取/已关，null=拉取中，数组=就绪 */
type CatalogState = CommandRow[] | null | undefined;

export class SessionService {
  private controller: SessionController | null = null;
  private activeId: string | null = null;
  private pendingOptimistic: { text: string } | null = null;
  private conn: ConnectionManager;
  private listeners = new Set<() => void>();
  /** M6b：命令目录（当前会话） */
  private catalog: CatalogState;
  private catalogError: string | null = null;
  /** M6c：$events 实时审批 */
  private hub: RemoteEventsHub | null = null;
  private pendingApprovals = new Map<string, PendingApprovalRequest>();

  constructor(
    conn: ConnectionManager,
    private deps: SessionServiceDeps,
  ) {
    this.conn = conn;
    conn.onChange((snap) => this.onConnection(snap));
  }

  getActiveSessionId(): string | null {
    return this.activeId;
  }

  /** 选中会话：切流、重置视图；会话可能在 ready 前被选中（等服务就绪后再 attach） */
  select(sessionId: string): void {
    if (sessionId === this.activeId) return;
    this.activeId = sessionId;
    this.pendingOptimistic = null;
    // 目录与审批卡都是「当前会话视角」：切换即关闭目录；审批 Map 保留（切回仍可答）
    this.closeSlash();
    this.controller?.dispose();
    this.controller = null;
    this.attachIfReady();
    this.emit();
  }

  /** 新建会话（写入边界：cwd=工作区根），成功后选中并刷新列表 */
  async create(): Promise<string> {
    const origin = this.conn.getOrigin();
    const cookie = this.conn.getCookie();
    if (!origin || !cookie) throw new Error('尚未连接');
    const id = await createSession({ origin, cookie }, this.deps.workspaceRoot);
    await this.conn.refreshSessions();
    this.select(id);
    return id;
  }

  /**
   * 发送一条输入（M3 + M6b 分流）：
   * - 以 '/' 开头 → 斜杠命令执行（commands/execute，整行下发，含后续参数）
   * - 否则 → session/prompt（普通消息，按 followUpMode）
   * 斜杠命令不设乐观占位：命令气泡由 command/run 事件驱动，避免重复渲染。
   */
  async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('/')) {
      await this.runSlash(trimmed);
      return;
    }
    const id = this.activeId;
    if (!id) return;
    const origin = this.conn.getOrigin();
    const cookie = this.conn.getCookie();
    if (!origin || !cookie) throw new Error('尚未连接');
    this.pendingOptimistic = { text: trimmed };
    this.emit();
    try {
      await promptSession({ origin, cookie }, id, trimmed, this.deps.followUpMode);
    } catch (err) {
      this.deps.log(`[prompt] 发送失败: ${String(err)}`);
      this.pendingOptimistic = null;
      this.emit();
    }
  }

  /** 打开命令目录（M6b）：对当前会话拉取一次 commands/list；失败置 error 供 UI 重试。 */
  private slashFetching = false;
  async openSlash(): Promise<void> {
    const id = this.activeId;
    const origin = this.conn.getOrigin();
    const cookie = this.conn.getCookie();
    if (!id || !origin || !cookie) {
      this.closeSlash();
      return;
    }
    // 同会话已就绪（含空目录）则跳过重复拉取；在途请求不叠加
    if (Array.isArray(this.catalog) && !this.catalogError) return;
    if (this.slashFetching) return;
    this.slashFetching = true;
    this.catalog = null; // 拉取中
    this.catalogError = null;
    this.emit();
    const deps: CommandApiDeps = { origin, cookie };
    try {
      const rows = await listCommands(deps, id);
      this.catalog = rows.map((c) => ({
        name: c.name,
        ...(c.description ? { description: c.description } : {}),
        ...(c.input?.hint ? { hint: c.input.hint } : {}),
      }));
      this.catalogError = null;
    } catch (err) {
      this.catalog = null;
      this.catalogError = err instanceof Error ? err.message : String(err);
      this.deps.log(`[commands] 目录拉取失败: ${this.catalogError}`);
    } finally {
      this.slashFetching = false;
    }
    this.emit();
  }

  /** 关闭命令目录（M6b：Esc/失焦/执行后由 UI 通知） */
  closeSlash(): void {
    if (this.catalog === undefined && this.catalogError === null) return;
    this.catalog = undefined;
    this.catalogError = null;
    this.emit();
  }

  /** 当前命令目录（undefined=关，null=拉取中/失败，数组=就绪） */
  getCommandCatalog(): { rows: CommandRow[] | null | undefined; error: string | null } {
    return { rows: this.catalog, error: this.catalogError };
  }

  /** M6c：应答当前会话的待批审批。outcome=allowed-once/rejected。 */
  async answerApproval(eventId: string, outcome: ApprovalOutcome): Promise<void> {
    if (!this.hub) {
      this.deps.log(`[approval] 应答被忽略：$events 未就绪（${eventId}）`);
      return;
    }
    try {
      await this.hub.answer(eventId, outcome);
    } catch (err) {
      this.deps.log(`[approval] 应答失败: ${String(err)}`);
      throw err;
    }
    // 服务端随后回 cancel 帧；本地先移除让卡片即时消失（幂等）
    if (this.pendingApprovals.delete(eventId)) this.emit();
  }

  /** 当前会话（activeId）最早一条待批审批；无则 null */
  getPendingApproval(): ApprovalView | null {
    if (!this.activeId) return null;
    for (const req of this.pendingApprovals.values()) {
      if (req.sessionId !== this.activeId) continue;
      return {
        eventId: req.eventId,
        toolName: req.toolName,
        ...(req.callId ? { callId: req.callId } : {}),
        ...(req.reason ? { reason: req.reason } : {}),
      };
    }
    return null;
  }

  /** M6d：当前会话目标投影（无控制器/未知 → null） */
  getGoal(): GoalBrief | null {
    return this.controller?.getViewModel().getGoal() ?? null;
  }

  /** M6d：pause/resume/clear 当前目标。ref 取投影（RPC CAS 防漂移）；成功等 goal/change 事件回流。 */
  async goalAction(action: 'pause' | 'resume' | 'clear'): Promise<void> {
    const id = this.activeId;
    const goal = this.getGoal();
    const origin = this.conn.getOrigin();
    const cookie = this.conn.getCookie();
    if (!id || !goal || !origin || !cookie) return;
    const ref: GoalRef = { id: goal.id, revision: goal.revision };
    try {
      await mutateGoal({ origin, cookie }, id, ref, action);
    } catch (err) {
      this.deps.log(`[goal] ${action} 失败: ${String(err)}`);
    }
  }

  /** M6d：新建目标 = 走 /goal 斜杠命令（与官方一致，见设计文档 §4） */
  async createGoal(objective: string): Promise<void> {
    const text = objective.trim();
    if (!text) return;
    await this.runSlash(`/goal ${text}`);
  }

  async stop(): Promise<void> {
    const id = this.activeId;
    const origin = this.conn.getOrigin();
    const cookie = this.conn.getCookie();
    if (!id || !origin || !cookie) return;
    try {
      await cancelSession({ origin, cookie }, id);
    } catch (err) {
      this.deps.log(`[cancel] 停止失败: ${String(err)}`);
    }
  }

  /** 监听消息/状态变化（provider 据此重新下发 host/state） */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 组装 UI 用的消息列表（含乐观占位；真实事件到达后自动去重） */
  getMessages(): ViewMessage[] {
    const out: ViewMessage[] = [];
    const entries = this.controller?.getViewModel().getState().entries ?? [];
    for (const e of entries) {
      out.push(entryToMessage(e));
    }
    const last = entries[entries.length - 1];
    if (
      this.pendingOptimistic &&
      !(last && last.kind === 'user' && last.text === this.pendingOptimistic.text)
    ) {
      out.push({
        id: 'optimistic',
        role: 'user',
        text: this.pendingOptimistic.text,
      });
    } else {
      this.pendingOptimistic = null;
    }
    return out;
  }

  /** 是否正在生成（决定「停止」按钮显隐）：视图里有流式尾巴或乐观消息未确认 */
  isRunning(): boolean {
    const entries = this.controller?.getViewModel().getState().entries ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.kind === 'status' || e.kind === 'command') continue;
      if (e.kind === 'assistant') return Boolean(e.streaming);
      if (e.kind === 'user') break;
    }
    return this.pendingOptimistic !== null;
  }

  private async runSlash(line: string): Promise<void> {
    const id = this.activeId;
    const origin = this.conn.getOrigin();
    const cookie = this.conn.getCookie();
    if (!id || !origin || !cookie) return;
    try {
      const result = await runCommand({ origin, cookie }, id, line);
      if (!result.ok) {
        this.deps.log(`[command] ${line} → ${result.text ?? '命令未受理'}`);
      }
    } catch (err) {
      this.deps.log(`[command] ${line} 执行失败: ${String(err)}`);
    }
  }

  private onConnection(snap: LiteSnapshot): void {
    if (snap.phase === 'ready') {
      this.ensureHub();
      this.attachIfReady();
      // 尚未选中时自动选最新会话（列表已按 cwd 过滤）
      if (!this.activeId && snap.sessions.length > 0) {
        this.select(snap.sessions[0].sessionId);
      }
    } else if (snap.phase !== 'connecting') {
      // 断开/出错：目录与审批卡片清场。审批 Map 一并清空——
      // 若只是 WS 断（进程在），重连后网关会对新 $events 代次重推待批瀑布（幂等重建）。
      this.closeSlash();
      if (this.pendingApprovals.size > 0) {
        this.pendingApprovals.clear();
        this.emit();
      }
      this.hub?.close();
      this.hub = null;
    }
    this.emit();
  }

  /** $events 实时审批流（连接级）：就绪即挂，与是否选中会话无关 */
  private ensureHub(): void {
    const mux = this.conn.getMux();
    if (!mux || mux.getState() !== 'open') return;
    if (!this.hub) {
      this.hub = new RemoteEventsHub(mux, {
        onApprovalRequest: (req) => {
          this.pendingApprovals.set(req.eventId, req);
          this.emit();
        },
        onApprovalCancelled: (eventId) => {
          if (this.pendingApprovals.delete(eventId)) this.emit();
        },
        log: (line) => this.deps.log(line),
      });
    }
    this.hub.attach();
  }

  private attachIfReady(): void {
    this.ensureHub();
    if (!this.activeId) return;
    const mux = this.conn.getMux();
    if (!mux || mux.getState() !== 'open') return;
    if (this.controller && this.controller.sessionId === this.activeId) {
      // 已订阅同一会话：断线重连后 mux 是新的 socket，流已失效，重建
      this.controller.reattach();
      return;
    }
    this.controller = new SessionController(this.activeId, { mux, log: this.deps.log });
    this.controller.getViewModel().onChange(() => this.emit());
    this.controller.attach();
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }
}

function entryToMessage(e: ViewEntry): ViewMessage {
  const base: ViewMessage = {
    id: `s${e.seq}`,
    role: e.kind === 'user' ? 'user' : e.kind === 'assistant' ? 'assistant' : 'system',
    text: e.text,
    ...(e.streaming ? { streaming: true } : {}),
  };
  // M4：tool 条目统一 kind=tool，phase 用 toolState 表达（call=命令行 / result=可折叠结果）
  if (e.kind === 'tool') {
    base.kind = 'tool';
    if (e.toolState) base.toolState = e.toolState;
  }
  // M6b：command 条目统一 kind=command，配对态用 cmdState/cmdOk 表达
  if (e.kind === 'command') {
    base.kind = 'command';
    if (e.cmdState) base.cmdState = e.cmdState;
    if (e.cmdOk !== undefined) base.cmdOk = e.cmdOk;
    if (e.resultText) base.resultText = e.resultText;
  }
  return base;
}
