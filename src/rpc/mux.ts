// src/rpc/mux.ts — /api/remote.mux 的 WS 客户端（低层传输，不含重连策略）
// 帧格式见 docs/api/remote-mux.md §2.1。payload 必须是 { args: {...} }（§2.3 头号坑）。
// 依赖决策：bundle ws@8（autoPong 默认 true，与 DSH 2s ping 心跳匹配），见 docs/api/connection.md §5.1。
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export interface MuxError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** 服务端 → 客户端帧 */
export type ServerFrame =
  | { type: 'item'; streamId: string; value: unknown }
  | { type: 'end'; streamId: string }
  | { type: 'error'; streamId: string; error: MuxError };

/** 客户端 → 服务端帧 */
export type ClientFrame =
  | { type: 'open'; streamId: string; endpoint: string; payload: { args: Record<string, unknown> } }
  | { type: 'cancel'; streamId: string };

export type MuxState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed';

/** 打开一条流返回的句柄：事件回调式，替代 probe 的「收集数组」 */
export interface MuxStream<T = unknown> {
  readonly streamId: string;
  onItem(cb: (value: T) => void): void;
  onEnd(cb: () => void): void;
  onError(cb: (err: MuxError) => void): void;
  cancel(): void;
}

/** 创建 socket 的工厂（生产用 ws 模块；单测可注入假 socket） */
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export interface SocketLike {
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'unexpected-response', cb: (_req: unknown, res: { statusCode?: number }) => void): void;
  send(data: string): void;
  close(): void;
  terminate?(): void;
}

export interface MuxOptions {
  /** 握手超时（默认 5000ms） */
  connectTimeoutMs?: number;
  createSocket?: SocketFactory;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

export class MuxClient {
  private socket: SocketLike | null = null;
  private streams = new Map<string, MuxStreamImpl<unknown>>();
  private state: MuxState = 'idle';
  private stateListeners = new Set<(s: MuxState) => void>();
  /** 非主动关闭（对端断开/升级被拒）时回调，供上层判断是否需要重连 */
  private unexpectedCloseListeners = new Set<(reason: string) => void>();
  private connectTimeoutMs: number;
  private createSocket: SocketFactory;
  private expectedClose = false;

  constructor(opts: MuxOptions = {}) {
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.createSocket =
      opts.createSocket ??
      ((url, headers) => new WebSocket(url, { headers, autoPong: true }) as unknown as SocketLike);
  }

  getState(): MuxState {
    return this.state;
  }

  onStateChange(cb: (s: MuxState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  /** 非主动断开的回调（reason 供日志） */
  onUnexpectedClose(cb: (reason: string) => void): () => void {
    this.unexpectedCloseListeners.add(cb);
    return () => this.unexpectedCloseListeners.delete(cb);
  }

  /** 建立连接。URL 形如 ws://host:port/api/remote.mux；cookie 从启动令牌交换而来。 */
  connect(url: string, cookie: string): Promise<void> {
    if (this.state === 'open' || this.state === 'connecting') return Promise.resolve();
    this.setState('connecting');
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            this.socket?.close();
          } catch {
            /* 忽略 */
          }
          this.setState('closed');
          reject(new Error(`WS 握手超时（${this.connectTimeoutMs}ms）`));
        }
      }, this.connectTimeoutMs);
      timer.unref?.();

      let socket: SocketLike;
      try {
        socket = this.createSocket(url, { cookie });
      } catch (err) {
        this.setState('closed');
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.socket = socket;

      socket.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.setState('open');
        resolve();
      });
      socket.on('unexpected-response', (_req, res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.setState('closed');
        reject(new Error(`WS 升级被拒: HTTP ${res.statusCode ?? '?'}`));
      });
      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.setState('closed');
          reject(err);
        }
      });
      socket.on('close', () => {
        clearTimeout(timer);
        const wasOpen = this.state === 'open';
        this.setState('closed');
        for (const s of this.streams.values()) s.settleError({ code: 'connection-closed', message: '连接已关闭' });
        const expected = this.expectedClose;
        this.expectedClose = false;
        if (wasOpen && !expected) {
          this.emitUnexpectedClose('socket closed');
        }
      });
      socket.on('message', (data) => {
        let msg: ServerFrame;
        try {
          msg = JSON.parse(String(data)) as ServerFrame;
        } catch {
          return;
        }
        if (msg.type === 'item' || msg.type === 'end' || msg.type === 'error') {
          const s = this.streams.get(msg.streamId);
          if (!s) return;
          if (msg.type === 'item') s.emitItem(msg.value);
          else if (msg.type === 'end') s.settleEnd();
          else s.settleError(msg.error);
        }
      });
    });
  }

  /** 打开一条流。args 必须按端点 wire 名组装（如 session/list → { _request: {} }）。 */
  open<T = unknown>(endpoint: string, args: Record<string, unknown>): MuxStream<T> {
    if (this.state !== 'open' || !this.socket) {
      throw new Error('mux 未连接');
    }
    const socket = this.socket;
    const impl = new MuxStreamImpl<T>(endpoint);
    const cleanup = () => this.streams.delete(impl.streamId);
    impl.onEnd(cleanup);
    impl.onError(cleanup);
    // cancel：发 cancel 帧 + 本地置终（服务端随后可能仍回 end/error，届时已被移除，忽略即可）
    impl.onCancel(() => {
      this.streams.delete(impl.streamId);
      try {
        socket.send(JSON.stringify({ type: 'cancel', streamId: impl.streamId } satisfies ClientFrame));
      } catch {
        /* socket 已关，忽略 */
      }
    });
    this.streams.set(impl.streamId, impl as MuxStreamImpl<unknown>);
    const frame: ClientFrame = { type: 'open', streamId: impl.streamId, endpoint, payload: { args } };
    socket.send(JSON.stringify(frame));
    return impl;
  }

  close(): void {
    this.expectedClose = true;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* 忽略 */
      }
    }
    this.setState('closing');
  }

  private setState(s: MuxState): void {
    if (this.state === s) return;
    this.state = s;
    for (const cb of this.stateListeners) cb(s);
  }

  private emitUnexpectedClose(reason: string): void {
    for (const cb of this.unexpectedCloseListeners) cb(reason);
  }
}

class MuxStreamImpl<T> implements MuxStream<T> {
  readonly streamId = `s${randomUUID().slice(0, 8)}`;
  private itemCbs = new Set<(v: T) => void>();
  private endCbs = new Set<() => void>();
  private errorCbs = new Set<(e: MuxError) => void>();
  private cancelCbs = new Set<() => void>();
  private done = false;

  constructor(readonly endpoint: string) {}

  onItem(cb: (v: T) => void): void {
    this.itemCbs.add(cb);
  }
  onEnd(cb: () => void): void {
    this.endCbs.add(cb);
  }
  onError(cb: (e: MuxError) => void): void {
    this.errorCbs.add(cb);
  }
  /** 仅 MuxClient 内部注册：cancel 时向 socket 发帧 */
  onCancel(cb: () => void): void {
    this.cancelCbs.add(cb);
  }
  cancel(): void {
    if (this.done) return;
    this.done = true;
    for (const cb of this.cancelCbs) cb();
    for (const cb of this.endCbs) cb();
    this.itemCbs.clear();
    this.endCbs.clear();
    this.errorCbs.clear();
    this.cancelCbs.clear();
  }
  emitItem(v: unknown): void {
    if (this.done) return;
    for (const cb of this.itemCbs) cb(v as T);
  }
  settleEnd(): void {
    if (this.done) return;
    this.done = true;
    for (const cb of this.endCbs) cb();
    this.itemCbs.clear();
    this.endCbs.clear();
    this.errorCbs.clear();
    this.cancelCbs.clear();
  }
  settleError(e: MuxError): void {
    if (this.done) return;
    this.done = true;
    for (const cb of this.errorCbs) cb(e);
    this.itemCbs.clear();
    this.endCbs.clear();
    this.errorCbs.clear();
    this.cancelCbs.clear();
  }
}
