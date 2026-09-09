// src/connection.ts — ConnectionManager：组合 服务层 + 令牌换 cookie + WS + 会话清单
// 对外单一快照源（docs/api/connection.md §6/§7）；自动重连策略（L1/L2）在本文件内聚。
import { probeService } from './process/detect';
import { MuxClient } from './rpc/mux';
import { listSessions } from './session/list';
import { ServiceManager } from './process/manager';
import { createProcessRunner } from './process/process';
import type { SessionBrief, LiteErrorCode } from './model';
import type { ConnectionState } from './panel/protocol';

/** 与 PanelState.connection 对齐的连接态 */
export type LitePhase = ConnectionState;

export interface LiteSnapshot {
  phase: LitePhase;
  errorCode: LiteErrorCode | null;
  sessions: SessionBrief[];
  /** 就绪的带令牌地址（仅日志/换 cookie 用，不上 UI） */
  authUrl: string | null;
  port: number;
}

export interface ConnectionOptions {
  host: string;
  port: number;
  /** 子进程 cwd（工作区根；缺省不指定） */
  cwd?: string;
  executablePath?: string;
  autoStart: boolean;
  /** 会话列表的 cwd 过滤根（工作区根；缺省不过滤） */
  /** @deprecated M7 起列表不再按工作区过滤（显示全部历史）；保留字段仅为兼容调用方。 */
  workspaceRoot?: string;
}

export interface ConnectionDeps {
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** L2 重连退避上限（默认 5 次：1+2+4+8+16 ≈ 31s） */
  maxReconnectAttempts?: number;
  reconnectBaseMs?: number;
}

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_BASE_MS = 1000;

export class ConnectionManager {
  private mgr: ServiceManager;
  private mux = new MuxClient();
  private phase: LitePhase = 'idle';
  private errorCode: LiteErrorCode | null = null;
  private sessions: SessionBrief[] = [];
  private cookie: string | null = null;
  private origin: string | null = null;
  private authUrl: string | null = null;
  private port: number;
  private listeners = new Set<(s: LiteSnapshot) => void>();
  private op: Promise<LiteSnapshot> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private maxReconnectAttempts: number;
  private reconnectBaseMs: number;

  constructor(
    opts: ConnectionOptions,
    private deps: ConnectionDeps,
  ) {
    this.maxReconnectAttempts = deps.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.reconnectBaseMs = deps.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.port = opts.port;
    this.mgr = new ServiceManager(
      {
        host: opts.host,
        port: opts.port,
        cwd: opts.cwd,
        executablePath: opts.executablePath,
        autoStart: opts.autoStart,
      },
      {
        probeService,
        processRunner: createProcessRunner(),
        log: deps.log,
      },
    );
    // L2 自动重连接线：socket 非主动断开（进程活着）→ scheduleReconnect
    this.mux.onUnexpectedClose(() => this.scheduleReconnect());
  }

  getSnapshot(): LiteSnapshot {
    return { phase: this.phase, errorCode: this.errorCode, sessions: this.sessions, authUrl: this.authUrl, port: this.port };
  }

  onChange(cb: (s: LiteSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(partial: Partial<LiteSnapshot>): void {
    if (partial.phase !== undefined) this.phase = partial.phase;
    if (partial.errorCode !== undefined) this.errorCode = partial.errorCode;
    if (partial.sessions !== undefined) this.sessions = partial.sessions;
    if (partial.authUrl !== undefined) this.authUrl = partial.authUrl;
    if (partial.port !== undefined) this.port = partial.port;
    const snap = this.getSnapshot();
    for (const cb of this.listeners) cb(snap);
  }

  /** 确保连接就绪（幂等；并发共享同一次流程）。面板打开 / ui:refresh 触发。 */
  ensureConnected(): Promise<LiteSnapshot> {
    if (this.op) return this.op;
    if (this.phase === 'ready') return Promise.resolve(this.getSnapshot());
    this.op = this.boot().finally(() => {
      this.op = null;
    });
    return this.op;
  }

  /** 用户「重连」：进程没起则重启，起了只重建 WS */
  async reconnect(): Promise<LiteSnapshot> {
    if (this.op) return this.op;
    this.op = (async () => {
      this.cancelReconnectTimer();
      this.reconnectAttempts = 0;
      const svc = this.mgr.getSnapshot();
      if (svc.state === 'ready' && this.cookie && this.origin) {
        await this.openMux();
        return this.getSnapshot();
      }
      this.mux.close();
      await this.mgr.restart();
      return this.boot();
    })().finally(() => {
      this.op = null;
    });
    return this.op;
  }

  /** 停止：关 WS + 停进程 → idle */
  async stop(): Promise<void> {
    this.cancelReconnectTimer();
    this.mux.close();
    this.cookie = null;
    this.origin = null;
    this.authUrl = null;
    await this.mgr.stop();
    this.set({ phase: 'idle', errorCode: null, sessions: [] });
  }

  private async boot(): Promise<LiteSnapshot> {
    this.cancelReconnectTimer();
    this.reconnectAttempts = 0;
    this.set({ phase: 'connecting', errorCode: null });
    const svc = await this.mgr.ensureRunning();
    if (svc.state === 'failed') {
      this.set({ phase: 'error', errorCode: this.toErr(svc.errorCode) });
      return this.getSnapshot();
    }
    if (svc.state !== 'ready' || !svc.authUrl) {
      return this.getSnapshot();
    }
    try {
      this.cookie = await this.exchangeCookie(svc.authUrl);
    } catch (err) {
      this.deps.log(`[auth] 令牌换 cookie 失败: ${String(err)}`);
      this.cookie = null;
      this.set({ phase: 'error', errorCode: 'err.cookieExchange' });
      return this.getSnapshot();
    }
    this.deps.log('[auth] cookie 已交换，建立 WS…');
    const origin = new URL(svc.authUrl).origin;
    this.origin = origin;
    this.authUrl = svc.authUrl;
    this.port = svc.port;
    await this.openMux();
    return this.getSnapshot();
  }

  private async openMux(): Promise<void> {
    if (!this.origin || !this.cookie) {
      this.set({ phase: 'error', errorCode: 'err.cookieExchange' });
      return;
    }
    const wsUrl = `ws://${new URL(this.origin).host}/api/remote.mux`;
    try {
      await this.mux.connect(wsUrl, this.cookie);
    } catch (err) {
      this.deps.log(`[rpc] WS 建连失败: ${String(err)}`);
      this.set({ phase: 'error', errorCode: 'err.wsUnreachable' });
      return;
    }
    this.reconnectAttempts = 0;
    this.set({ phase: 'ready', errorCode: null });
    this.deps.log('[rpc] WS 已连接，拉取会话清单…');
    await this.refreshSessions();
  }

  /** 拉取会话清单（M7 起不再按工作区 cwd 过滤：与官方浏览器一致显示全部历史会话，UI 行内标注所属目录） */
  async refreshSessions(): Promise<void> {
    if (!this.origin || !this.cookie) return;
    try {
      const all = await listSessions(this.origin, this.cookie, this.deps.fetchImpl);
      this.set({ sessions: all });
    } catch (err) {
      this.deps.log(`[session] session/list 失败: ${String(err)}`);
    }
  }

  /** 访问当前 mux（ready 后有值；M2 会话层 follow/page 使用） */
  getMux(): MuxClient | null {
    return this.phase === 'ready' ? this.mux : null;
  }

  getOrigin(): string | null {
    return this.origin;
  }

  getCookie(): string | null {
    return this.cookie;
  }

  private exchangeCookie(authUrl: string): Promise<string> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    return (async () => {
      const res = await fetchImpl(authUrl, { redirect: 'manual' });
      const raw = res.headers.get('set-cookie');
      if (!raw) throw new Error(`令牌交换未拿到 cookie (status=${res.status})`);
      const cookie = raw.split(';')[0]?.trim() ?? '';
      if (!cookie) throw new Error('空 cookie');
      return cookie;
    })();
  }

  /**
   * L2 自动重连（docs/api/connection.md §6）：
   * - 进程没了（mgr idle）→ offline，不自动重启进程
   * - 进程在 → 指数退避重连，成功后 refreshSessions；超上限 → error
   */
  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.phase !== 'ready') return;
    const svc = this.mgr.getSnapshot();
    if (svc.state === 'idle') {
      this.set({ phase: 'offline', errorCode: 'err.connectionLost' });
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.set({ phase: 'error', errorCode: 'err.wsUnreachable' });
      return;
    }
    this.reconnectAttempts += 1;
    const delay = this.reconnectBaseMs * 2 ** (this.reconnectAttempts - 1);
    this.deps.log(`[rpc] WS 断开，${delay}ms 后第 ${this.reconnectAttempts}/${this.maxReconnectAttempts} 次重连`);
    this.set({ phase: 'connecting', errorCode: null });
    this.reconnectTimer = setTimeout(() => {
      void this.openMux().then(() => {
        const snap = this.getSnapshot();
        if (snap.phase === 'ready') {
          this.deps.log('[rpc] 重连成功');
        } else if (snap.phase === 'error') {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private toErr(code: string | null): LiteErrorCode | null {
    if (!code) return null;
    const map: Record<string, LiteErrorCode> = {
      dshNotFound: 'err.dshNotFound',
      nodeNotFound: 'err.nodeNotFound',
      spawnEinval: 'err.spawnEinval',
      portOccupied: 'err.portOccupied',
      startTimeout: 'err.startTimeout',
      startCrashed: 'err.startCrashed',
      tokenParse: 'err.tokenParse',
    };
    return map[code] ?? 'err.dshNotFound';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelReconnectTimer();
    this.listeners.clear();
  }
}
