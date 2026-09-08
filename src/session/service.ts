// src/session/service.ts — 会话编排：选中会话 + follow 订阅 + 发送/停止/新建（对外给 provider）
import type { ConnectionManager, LiteSnapshot } from '../connection';
import type { ViewMessage } from '../model';
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

export class SessionService {
  private controller: SessionController | null = null;
  private activeId: string | null = null;
  private pendingOptimistic: { text: string } | null = null;
  private conn: ConnectionManager;
  private listeners = new Set<() => void>();

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

  /** 发送消息（M3）。若会话未在跑，直接 prompt；若在跑，按 followUpMode 处理（仍走 prompt 的 mode 字段）。 */
  async submit(text: string): Promise<void> {
    const id = this.activeId;
    if (!id || !text.trim()) return;
    const origin = this.conn.getOrigin();
    const cookie = this.conn.getCookie();
    if (!origin || !cookie) throw new Error('尚未连接');
    this.pendingOptimistic = { text };
    this.emit();
    try {
      await promptSession({ origin, cookie }, id, text, this.deps.followUpMode);
    } catch (err) {
      this.deps.log(`[prompt] 发送失败: ${String(err)}`);
      this.pendingOptimistic = null;
      this.emit();
    }
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
      if (e.kind === 'status') continue;
      if (e.kind === 'assistant') return Boolean(e.streaming);
      if (e.kind === 'user') break;
    }
    return this.pendingOptimistic !== null;
  }

  private onConnection(snap: LiteSnapshot): void {
    if (snap.phase === 'ready') {
      this.attachIfReady();
      // 尚未选中时自动选最新会话（列表已按 cwd 过滤）
      if (!this.activeId && snap.sessions.length > 0) {
        this.select(snap.sessions[0].sessionId);
      }
    }
    this.emit();
  }

  private attachIfReady(): void {
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
  return base;
}
