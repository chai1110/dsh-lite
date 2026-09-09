// src/session/controller.ts — 单个会话的 follow 订阅（流式事件 → 视图模型）
import type { MuxClient, MuxStream } from '../rpc/mux';
import type { RawEvent } from './events';
import { SessionViewModel } from './viewmodel';

/** follow 快照帧 records[] 里单条的结构（与 remote-mux 契约一致；type 段未被消费，置必填以对齐 applyRecords） */
interface SnapshotRecord {
  type: string;
  event?: RawEvent;
  seq?: number;
}

export interface ControllerDeps {
  mux: MuxClient;
  log: (line: string) => void;
}

export class SessionController {
  private stream: MuxStream<unknown> | null = null;
  private vm = new SessionViewModel();
  private closed = false;

  constructor(
    readonly sessionId: string,
    private deps: ControllerDeps,
  ) {}

  getViewModel(): SessionViewModel {
    return this.vm;
  }

  /** 打开 follow 流并订阅事件；断线由上层（SessionService）决定是否重建 */
  attach(): void {
    if (this.closed || !this.deps.mux || this.deps.mux.getState() !== 'open') return;
    try {
      this.stream = this.deps.mux.open('session/follow', {
        request: { address: { kind: 'session', sessionId: this.sessionId } },
      });
    } catch (err) {
      this.deps.log(`[follow] 打开失败: ${String(err)}`);
      return;
    }
    this.stream.onItem((value) => {
      this.handleFrame(value);
    });
    this.stream.onError((err) => {
      this.deps.log(`[follow] 流错误: ${err.code} ${err.message}`);
    });
    this.stream.onEnd(() => {
      this.stream = null;
    });
  }

  /** 切换/重连后重建流（ViewModel 内容保留，由调用方决定是否 reset） */
  reattach(): void {
    this.close();
    this.attach();
  }

  close(): void {
    try {
      this.stream?.cancel();
    } catch {
      /* 忽略 */
    }
    this.stream = null;
  }

  dispose(): void {
    this.closed = true;
    this.close();
  }

  private handleFrame(value: unknown): void {
    if (typeof value !== 'object' || value === null) return;
    const v = value as { type?: string; event?: unknown; records?: unknown };
    if (v.type === 'event' && v.event) {
      this.vm.applyEvent(v.event as Parameters<SessionViewModel['applyEvent']>[0]);
      return;
    }
    if (v.type === 'snapshot') {
      const snap = v as { records?: SnapshotRecord[]; cursor?: number };
      this.vm.reset();
      this.vm.applyRecords(snap.records);
      this.deps.log(`[follow] 会话快照已载入（${snap.records?.length ?? 0} 条记录）`);
      return;
    }
    // chunks / 其它帧：不消费（快照里的 chunks 归 snapshot 处理；独立 chunks 帧暂忽略）
  }
}
