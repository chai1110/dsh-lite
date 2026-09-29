// src/connection.ts — ConnectionManager（iframe 架构精简版）。
//
// 职责：
//   1. 管理 dsh web 子进程（自启/重启/停止，token 从 stdout 解析）；
//   2. 令牌换 cookie（一次性；cookie 注入由 Lite 代理在转发时完成）；
//   3. 就绪后对外发快照（phase/authUrl/port/origin/cookie），extension 据此起本地代理。
//
// 已退役：WS mux 客户端、会话清单拉取（官方页面自己经代理完成一切 RPC）。
import { probeService } from './process/detect';
import { ServiceManager } from './process/manager';
import { createProcessRunner } from './process/process';
/** 与面板展示对齐的连接态 */
export type LitePhase = 'idle' | 'connecting' | 'ready' | 'error' | 'offline';

/** 连接层对外错误 code（err.* 全集） */
export type LiteErrorCode =
  | 'err.dshNotFound'
  | 'err.nodeNotFound'
  | 'err.spawnEinval'
  | 'err.portOccupied'
  | 'err.startTimeout'
  | 'err.startCrashed'
  | 'err.tokenParse'
  | 'err.cookieExchange'
  | 'err.wsUnreachable'
  | 'err.connectionLost';

export interface LiteSnapshot {
  phase: LitePhase;
  errorCode: LiteErrorCode | null;
  /** 就绪的带令牌地址（日志/重试用） */
  authUrl: string | null;
  /** 实例端口 */
  port: number;
  /** 实例 origin（http://127.0.0.1:<port>） */
  origin: string | null;
  /** 兑换到的认证 cookie（代理注入用） */
  cookie: string | null;
}

export interface ConnectionOptions {
  host: string;
  port: number;
  cwd?: string;
  executablePath?: string;
  autoStart: boolean;
}

export interface ConnectionDeps {
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
}

export class ConnectionManager {
  private mgr: ServiceManager;
  private phase: LitePhase = 'idle';
  private errorCode: LiteErrorCode | null = null;
  private authUrl: string | null = null;
  private origin: string | null = null;
  private cookie: string | null = null;
  private port: number;
  private listeners = new Set<(s: LiteSnapshot) => void>();
  private op: Promise<LiteSnapshot> | null = null;
  private disposed = false;

  constructor(
    opts: ConnectionOptions,
    private deps: ConnectionDeps,
  ) {
    this.port = opts.port;
    this.mgr = new ServiceManager(
      {
        host: opts.host,
        port: opts.port,
        cwd: opts.cwd,
        executablePath: opts.executablePath,
        autoStart: opts.autoStart,
      },
      { probeService, processRunner: createProcessRunner(), log: deps.log },
    );
  }

  getSnapshot(): LiteSnapshot {
    return {
      phase: this.phase,
      errorCode: this.errorCode,
      authUrl: this.authUrl,
      port: this.port,
      origin: this.origin,
      cookie: this.cookie,
    };
  }

  onChange(cb: (s: LiteSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(partial: Partial<LiteSnapshot>): void {
    if (partial.phase !== undefined) this.phase = partial.phase;
    if (partial.errorCode !== undefined) this.errorCode = partial.errorCode;
    if (partial.authUrl !== undefined) this.authUrl = partial.authUrl;
    if (partial.port !== undefined) this.port = partial.port;
    if (partial.origin !== undefined) this.origin = partial.origin;
    if (partial.cookie !== undefined) this.cookie = partial.cookie;
    const snap = this.getSnapshot();
    for (const cb of this.listeners) cb(snap);
  }

  /** 确保连接就绪（幂等；并发共享同一次流程）：起服务 → 令牌换 cookie。 */
  ensureConnected(): Promise<LiteSnapshot> {
    if (this.op) return this.op;
    if (this.phase === 'ready') return Promise.resolve(this.getSnapshot());
    this.op = this.boot().finally(() => {
      this.op = null;
    });
    return this.op;
  }

  /** 用户「重试」：进程没起则重启，起了只重换 cookie */
  async reconnect(): Promise<LiteSnapshot> {
    if (this.op) return this.op;
    this.op = (async () => {
      const svc = this.mgr.getSnapshot();
      if (svc.state === 'ready' && this.cookie && this.origin) {
        return this.getSnapshot();
      }
      await this.mgr.restart();
      return this.boot();
    })().finally(() => {
      this.op = null;
    });
    return this.op;
  }

  /** 停止：停进程 → idle */
  async stop(): Promise<void> {
    this.cookie = null;
    this.origin = null;
    this.authUrl = null;
    await this.mgr.stop();
    this.set({ phase: 'idle', errorCode: null });
  }

  private async boot(): Promise<LiteSnapshot> {
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
    this.deps.log('[auth] cookie 已交换，Lite 代理就绪');
    const u = new URL(svc.authUrl);
    this.origin = u.origin;
    this.authUrl = svc.authUrl;
    this.port = Number(u.port);
    this.set({ phase: 'ready', errorCode: null });
    return this.getSnapshot();
  }

  private async exchangeCookie(authUrl: string): Promise<string> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(authUrl, { redirect: 'manual' });
    const raw = res.headers.get('set-cookie');
    if (!raw) throw new Error(`令牌交换未拿到 cookie (status=${res.status})`);
    const cookie = raw.split(';')[0]?.trim() ?? '';
    if (!cookie) throw new Error('空 cookie');
    return cookie;
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
    void this.mgr.stop();
  }
}
