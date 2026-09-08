// src/session/events-stream.ts — 连接级 $events 流（M6c 审批实时通道）
// 活体实测（0.1.2-rc.1）：mux open('$events', {}) → 首帧 {type:'ready', clientId, host:{…}}，
// 之后是瀑布请求/取消帧：
//   { type:'waterfall', event:'approval/request', eventId, agentId, request:{toolName, callId?, reason?} }
//   { type:'cancel', eventId }
// 应答 = 开 unary 流 '$events/result'，args {clientId, eventId, outcome:{kind:'result', value}}。
// 见 docs/design/命令与审批与目标.md §1。
import type { MuxClient, MuxError, MuxStream } from '../rpc/mux';

/** 一次待应答的审批请求（来自 approval/request 瀑布帧） */
export interface PendingApprovalRequest {
  eventId: string;
  /** 目标会话（帧内 agentId，即 sessionId） */
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
}

export interface EventsHubHandlers {
  onApprovalRequest(req: PendingApprovalRequest): void;
  onApprovalCancelled(eventId: string): void;
  log(line: string): void;
}

export type ApprovalOutcome = 'allowed-once' | 'rejected';

/** $events 流解析结果（把线缆帧归一化为高层事件） */
export class RemoteEventsHub {
  private stream: MuxStream<unknown> | null = null;
  private clientId: string | null = null;
  private closed = false;

  constructor(
    private mux: MuxClient,
    private handlers: EventsHubHandlers,
  ) {}

  getClientId(): string | null {
    return this.clientId;
  }

  /** 在 mux 就绪后打开 $events 流；断流自动清理（由上层在重连后重新 attach） */
  attach(): void {
    if (this.closed || !this.mux || this.mux.getState() !== 'open' || this.stream) return;
    try {
      this.stream = this.mux.open('$events', {});
    } catch (err) {
      this.handlers.log(`[$events] 打开失败: ${String(err)}`);
      return;
    }
    this.stream.onItem((value) => this.handleFrame(value));
    const drop = () => {
      // 流结束即弃 clientId：其只对本次 $events 代次有效（重连后 ready 帧会发新 id）
      this.stream = null;
      this.clientId = null;
    };
    this.stream.onError((err: MuxError) => {
      this.handlers.log(`[$events] 流错误: ${err.code} ${err.message}`);
      drop();
    });
    this.stream.onEnd(() => {
      drop();
    });
  }

  /** 应答一次审批。outcome 即瀑布返回值；成功本地无需处理（服务端随后回 cancel）。 */
  answer(eventId: string, outcome: ApprovalOutcome): Promise<void> {
    const clientId = this.clientId;
    if (!clientId) return Promise.reject(new Error('$events 未就绪（无 clientId）'));
    if (!this.mux || this.mux.getState() !== 'open') {
      return Promise.reject(new Error('mux 未连接'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        const stream = this.mux.open('$events/result', {
          clientId,
          eventId,
          outcome: { kind: 'result', value: outcome },
        });
        stream.onError((err) => {
          if (settled) return;
          settled = true;
          reject(new Error(`${err.code} ${err.message}`));
        });
        stream.onEnd(() => {
          if (settled) return;
          settled = true;
          resolve();
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.stream?.cancel();
    } catch {
      /* 忽略 */
    }
    this.stream = null;
    this.clientId = null;
  }

  private handleFrame(value: unknown): void {
    if (typeof value !== 'object' || value === null) return;
    const v = value as {
      type?: string;
      clientId?: unknown;
      event?: unknown;
      eventId?: unknown;
      agentId?: unknown;
      request?: unknown;
    };
    switch (v.type) {
      case 'ready': {
        if (typeof v.clientId === 'string' && v.clientId) this.clientId = v.clientId;
        return;
      }
      case 'waterfall': {
        if (v.event === 'approval/request') {
          const eventId = typeof v.eventId === 'string' ? v.eventId : '';
          const sessionId = typeof v.agentId === 'string' ? v.agentId : '';
          const req = v.request as { toolName?: unknown; callId?: unknown; reason?: unknown } | undefined;
          if (!eventId || !sessionId || !req || typeof req !== 'object') return;
          const toolName = typeof req.toolName === 'string' ? req.toolName : '';
          if (!toolName) return;
          const callId = typeof req.callId === 'string' ? req.callId : undefined;
          const reason = typeof req.reason === 'string' ? req.reason : undefined;
          this.handlers.onApprovalRequest({ eventId, sessionId, toolName, callId, reason });
        }
        // user-questions/request 等其它瀑布：本期不消费（见设计文档 §3「明确不做」）
        return;
      }
      case 'cancel': {
        const eventId = typeof v.eventId === 'string' ? v.eventId : '';
        if (eventId) this.handlers.onApprovalCancelled(eventId);
        return;
      }
      default:
        return;
    }
  }
}
