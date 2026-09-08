// src/process/manager.ts — 服务层状态机：探测 → 自起 → 等令牌地址 → ready（纯模块，依赖注入）
// 依据 docs/api/connection.md §3；与 0.5.1 manager.ts 的差异（不复用外部实例 / 无 authproxy / 错误用 code）见该文档附录 A。
import { extractDshWebUrl, findFreePort, PORT_FALLBACK_ATTEMPTS } from './detect';
import type { ChildProcessLike, ProcessRunner } from './process';
import type { ProbeResult, ServiceErrorCode, ServiceSnapshot, ServiceState } from './types';

export interface ManagerOptions {
  host: string;
  port: number;
  cwd?: string;
  executablePath?: string;
  autoStart: boolean;
  timeoutMs?: number;
  pollMs?: number;
}

export interface ManagerDeps {
  probeService: (host: string, port: number, timeoutMs?: number) => Promise<ProbeResult>;
  processRunner: ProcessRunner;
  log: (line: string) => void;
  /** 启动总超时（默认 15000） */
  startTimeoutMs?: number;
}

const DEFAULT_START_TIMEOUT_MS = 15000;
const DEFAULT_POLL_MS = 500;
const PORT_FALLBACK_MAX_ROUNDS = 3;

export class ServiceManager {
  private snapshot: ServiceSnapshot;
  private listeners = new Set<(s: ServiceSnapshot) => void>();
  private op: Promise<ServiceSnapshot> | null = null;
  private stopRequested = false;
  private child: ChildProcessLike | null = null;
  private childAuthUrl: string | null = null;
  private disposed = false;

  private parentExitHook = (): void => {
    try {
      this.child?.kill('SIGKILL');
    } catch {
      /* 进程可能已退出 */
    }
  };

  constructor(
    private opts: ManagerOptions,
    private deps: ManagerDeps,
  ) {
    this.snapshot = { state: 'idle', authUrl: null, port: opts.port, errorCode: null, owned: false };
    process.once('exit', this.parentExitHook);
  }

  getSnapshot(): ServiceSnapshot {
    return { ...this.snapshot };
  }

  onChange(cb: (s: ServiceSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(partial: Partial<ServiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const cb of this.listeners) cb(this.getSnapshot());
  }

  /** 确保服务就绪（幂等：并发共享同一次流程）。返回最终快照。 */
  ensureRunning(): Promise<ServiceSnapshot> {
    if (this.op) return this.op;
    if (this.snapshot.state === 'ready') return Promise.resolve(this.getSnapshot());
    this.stopRequested = false;
    this.op = this.doStart(0).finally(() => {
      this.op = null;
    });
    return this.op;
  }

  /** 重启：停掉自启子进程后重新走启动流程（用户「重连」） */
  restart(): Promise<ServiceSnapshot> {
    if (this.op) return this.op;
    this.stopRequested = false;
    this.op = (async () => {
      await this.stopOwned();
      return this.doStart(0);
    })().finally(() => {
      this.op = null;
    });
    return this.op;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.stopOwned();
  }

  private async stopOwned(): Promise<void> {
    if (!this.child) {
      this.set({ state: 'idle', authUrl: null, errorCode: null });
      return;
    }
    this.set({ state: 'stopping' });
    const child = this.child;
    this.child = null;
    try {
      await this.deps.processRunner.stopChild(child);
    } catch (err) {
      this.deps.log(`[process] 停止子进程失败: ${String(err)}`);
    }
    this.set({ state: 'idle', authUrl: null, errorCode: null });
  }

  /**
   * 完整启动流程：探测 → 自起（被占则回退空闲端口）→ 从 stdout 解析令牌地址 → ready。
   * 与 0.5.1 不同：任何探测结果都不复用外部实例（决策 A，见 docs/api/connection.md §2）。
   */
  private async doStart(rounds: number): Promise<ServiceSnapshot> {
    this.set({ state: 'detecting', authUrl: null, errorCode: null });
    const timeoutMs = this.deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const pollMs = this.opts.pollMs ?? DEFAULT_POLL_MS;
    /** 统一失败出口：确保已 spawn 的子进程被清理，不留孤儿/占用端口与锁 */
    const fail = (errorCode: ServiceErrorCode): ServiceSnapshot => {
      if (this.child) {
        const child = this.child;
        this.child = null;
        try {
          child.kill('SIGKILL');
        } catch {
          /* 进程可能已退出 */
        }
      }
      this.set({ state: 'failed', errorCode });
      return this.getSnapshot();
    };

    // 1) 探测目标端口：空闲直接占用；被占（任意类型）→ 回退首个空闲端口
    const probe = await this.deps.probeService(this.opts.host, this.opts.port, timeoutMs > 3000 ? 3000 : timeoutMs);
    let target = this.opts.port;
    if (probe !== 'down') {
      if (!this.opts.autoStart) {
        return fail('portOccupied');
      }
      const fallback = await findFreePort(
        this.opts.host,
        this.opts.port,
        PORT_FALLBACK_ATTEMPTS,
        this.deps.probeService,
      );
      if (fallback === null) {
        return fail('portOccupied');
      }
      if (this.stopRequested) return this.getSnapshot();
      this.deps.log(`[process] 端口 ${this.opts.port} 不可用（${probe}），本次会话改用 ${fallback}`);
      target = fallback;
    }
    if (!this.opts.autoStart) {
      return fail('dshNotFound');
    }

    // 2) 自起子进程
    if (this.stopRequested) return this.getSnapshot();
    this.set({ state: 'starting', port: target });
    let child: ChildProcessLike;
    try {
      child = this.deps.processRunner.startDsh({
        host: this.opts.host,
        port: target,
        cwd: this.opts.cwd,
        executablePath: this.opts.executablePath,
      });
    } catch (err) {
      return this.mapSpawnError(err);
    }
    this.child = child;
    this.childAuthUrl = null;

    // 3) 事件监听：error（ENOENT 等异步到达）、exit（启动期崩溃自愈）、stdout（解析令牌地址）
    let spawnFailed = false;
    let childExited = false;
    const logLastStart = this.deps.processRunner.lastStart;
    if (logLastStart) this.deps.log(`[process] 启动命令: ${logLastStart.command} ${logLastStart.args.join(' ')}`);

    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      this.deps.log(`[process] ${err.message} (code=${code})`);
      if (code === 'ENOENT') {
        spawnFailed = true;
        this.set({ state: 'failed', errorCode: 'dshNotFound' });
      } else if (code === 'EINVAL') {
        spawnFailed = true;
        this.set({ state: 'failed', errorCode: 'spawnEinval' });
      } else if (code === 'NODE_NOT_FOUND') {
        spawnFailed = true;
        this.set({ state: 'failed', errorCode: 'nodeNotFound' });
      }
    });
    child.on('exit', () => {
      // 就绪后子进程意外退出：回 idle（连接层据此判 offline）；启动期间退出由 waiting 循环处理
      if (this.snapshot.state === 'ready' && this.child === child) {
        this.child = null;
        this.set({ state: 'idle', authUrl: null, errorCode: null, owned: false });
        return;
      }
      childExited = true;
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.deps.log(`[stdout] ${text.trimEnd()}`);
      if (this.childAuthUrl === null) {
        const parsed = extractDshWebUrl(text);
        if (parsed !== null) this.childAuthUrl = parsed;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd();
      if (text) this.deps.log(`[stderr] ${text}`);
    });

    // 4) 等待就绪：持续解析 stdout 令牌地址直到启动超时截止（令牌解析不设独立宽限轮数，
    //    ——0.5.1 用「轮数×pollMs」算宽限，pollMs 调小会误伤启动偏慢的实例）
    this.set({ state: 'waiting' });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (spawnFailed || this.stopRequested) return this.getSnapshot();
      if (childExited) {
        this.child = null;
        // 启动期崩溃自愈：换空闲端口重启（最多 3 轮）；轮数用尽报 startCrashed
        if (this.opts.autoStart && rounds < PORT_FALLBACK_MAX_ROUNDS) {
          const fallback = await findFreePort(
            this.opts.host,
            target,
            PORT_FALLBACK_ATTEMPTS,
            this.deps.probeService,
          );
          if (fallback !== null && !this.stopRequested) {
            this.deps.log(`[process] 子进程启动期退出（端口 ${target}），改用 ${fallback} 重启`);
            this.opts = { ...this.opts, port: fallback };
            return this.doStart(rounds + 1);
          }
        }
        this.set({ state: 'failed', errorCode: 'startCrashed' });
        return this.getSnapshot();
      }
      if (this.childAuthUrl !== null) {
        this.set({ state: 'ready', authUrl: this.childAuthUrl, port: target, errorCode: null });
        return this.getSnapshot();
      }
      if (Date.now() >= deadline) {
        // 启动超时仍未从 stdout 拿到令牌：拿不到 cookie，RPC 必然 401，直接判失败（并清理子进程）
        return fail('tokenParse');
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  private mapSpawnError(err: unknown): ServiceSnapshot {
    const code = (err as NodeJS.ErrnoException).code;
    this.deps.log(`[process] 启动失败: ${String(err)} (code=${code})`);
    if (code === 'EINVAL') this.set({ state: 'failed', errorCode: 'spawnEinval' });
    else if (code === 'NODE_NOT_FOUND') this.set({ state: 'failed', errorCode: 'nodeNotFound' });
    else this.set({ state: 'failed', errorCode: 'dshNotFound' });
    return this.getSnapshot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // 仍有自启子进程时一并清理（防孤儿/占锁），并移除父进程退出钩子
    if (this.child) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
      this.child = null;
    }
    process.removeListener('exit', this.parentExitHook);
    this.listeners.clear();
  }
}

export type { ServiceErrorCode, ServiceSnapshot, ServiceState };
