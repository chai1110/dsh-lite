// test/service.test.ts — SessionService 单测：自动选中、切流不串、乐观去重、发送/停止
// 用 FakeConn + FakeMux 替身：不碰真实网络；follow 帧通过 FakeStream.push 注入。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionService } from '../src/session/service';
import type { SessionBrief } from '../src/model';
import type { ConnectionManager, LiteSnapshot } from '../src/connection';
import type { MuxClient, MuxStream } from '../src/rpc/mux';
import type { RawEvent } from '../src/session/events';

// ---------- fakes ----------

class FakeStream implements MuxStream<unknown> {
  readonly streamId: string;
  private itemCbs: Array<(v: unknown) => void> = [];
  private endCbs: Array<() => void> = [];
  private errCbs: Array<(e: { code: string; message: string }) => void> = [];
  cancelled = false;
  constructor(id: string) {
    this.streamId = id;
  }
  onItem(cb: (v: unknown) => void): void {
    this.itemCbs.push(cb);
  }
  onEnd(cb: () => void): void {
    this.endCbs.push(cb);
  }
  onError(cb: (e: { code: string; message: string }) => void): void {
    this.errCbs.push(cb);
  }
  cancel(): void {
    this.cancelled = true;
  }
  push(value: unknown): void {
    for (const cb of this.itemCbs) cb(value);
  }
  end(): void {
    for (const cb of this.endCbs) cb();
  }
}

class FakeMux {
  state = 'open';
  opened: Array<{ endpoint: string; payload: unknown; stream: FakeStream }> = [];
  getState(): string {
    return this.state;
  }
  open(endpoint: string, payload: unknown): MuxStream<unknown> {
    const stream = new FakeStream(`s${this.opened.length + 1}`);
    this.opened.push({ endpoint, payload, stream });
    return stream as unknown as MuxStream<unknown>;
  }
  followOf(sessionId: string): FakeStream | null {
    const hit = this.opened.find((o) => {
      const req = (o.payload as { request?: { address?: { sessionId?: string } } }).request;
      return req?.address?.sessionId === sessionId;
    });
    return hit?.stream ?? null;
  }
  streamByIndex(i: number): FakeStream {
    return this.opened[i].stream;
  }
}

class FakeConn {
  phase: 'idle' | 'ready' = 'idle';
  origin = 'http://127.0.0.1:3082';
  cookie = 'dsh-auth-token';
  sessions: SessionBrief[] = [];
  mux = new FakeMux();
  refreshCalls = 0;
  private listeners: Array<(s: LiteSnapshot) => void> = [];

  onChange(cb: (s: LiteSnapshot) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }
  getSnapshot(): LiteSnapshot {
    return { phase: this.phase, errorCode: null, sessions: this.sessions, authUrl: null, port: 3082 };
  }
  getMux(): MuxClient | null {
    return (this.phase === 'ready' ? this.mux : null) as unknown as MuxClient | null;
  }
  getOrigin(): string | null {
    return this.phase === 'ready' ? this.origin : null;
  }
  getCookie(): string | null {
    return this.phase === 'ready' ? this.cookie : null;
  }
  async refreshSessions(): Promise<void> {
    this.refreshCalls++;
  }
  /** 测试用：把连接推到 ready 并广播 */
  becomeReady(sessions: SessionBrief[]): void {
    this.phase = 'ready';
    this.sessions = sessions;
    this.emit();
  }
  private emit(): void {
    const snap = this.getSnapshot();
    for (const cb of this.listeners) cb(snap);
  }
}

function brief(id: string, title?: string, updatedAt = 0): SessionBrief {
  return { sessionId: id, title: title ?? id, updatedAt, running: false };
}

/** 注入 follow 事件帧的便捷函数 */
function eventFrame(e: RawEvent): { type: 'event'; event: RawEvent } {
  return { type: 'event', event: e };
}
function userMsg(seq: number, text: string, extra: Partial<RawEvent> = {}): RawEvent {
  return { type: 'user/message', seq, data: { text }, ...extra };
}

function makeService(conn: FakeConn, mode: 'queue' | 'steer' = 'queue'): SessionService {
  const svc = new SessionService(conn as unknown as ConnectionManager, {
    log: () => {},
    workspaceRoot: '/ws',
    followUpMode: mode,
  });
  return svc;
}

// ---------- 用例 ----------

test('连接 ready 且未选中时自动选最新会话并挂 follow 流', () => {
  const conn = new FakeConn();
  const svc = makeService(conn);
  assert.equal(svc.getActiveSessionId(), null);

  conn.becomeReady([brief('a', 'A', 2), brief('b', 'B', 1)]);
  assert.equal(svc.getActiveSessionId(), 'a'); // sessions[0] = 最新
  // M6：连接就绪即挂 $events 审批流（第 1 条），随后才挂会话 follow（第 2 条）
  assert.equal(conn.mux.opened.length, 2);
  assert.equal(conn.mux.opened[0].endpoint, '$events');
  assert.equal(conn.mux.opened[1].endpoint, 'session/follow');
  assert.ok(conn.mux.followOf('a'), 'a 会话的 follow 流已挂');

  // 注入一条用户消息，消息列表应可见
  const stream = conn.mux.followOf('a')!;
  stream.push(eventFrame(userMsg(1, '你好')));
  const msgs = svc.getMessages();
  assert.equal(msgs.length, 1);
  assert.deepEqual({ id: msgs[0].id, role: msgs[0].role, text: msgs[0].text }, { id: 's1', role: 'user', text: '你好' });
});

test('切换会话后视图不串（旧会话条目不可见）', () => {
  const conn = new FakeConn();
  const svc = makeService(conn);
  conn.becomeReady([brief('a', 'A', 2), brief('b', 'B', 1)]);

  conn.mux.followOf('a')!.push(eventFrame(userMsg(1, '在 A 会话说')));
  assert.equal(svc.getMessages().length, 1);

  svc.select('b');
  assert.equal(svc.getActiveSessionId(), 'b');
  // 新会话没有事件 → 空列表；旧 A 的内容不出现
  assert.equal(svc.getMessages().length, 0);
  // b 的 follow 是本次新开的流，且与 a 的流不是同一个（hub 占第 1 条，a follow 第 2 条，b follow 第 3 条）
  assert.equal(conn.mux.followOf('b'), conn.mux.streamByIndex(2));
  assert.notEqual(conn.mux.followOf('b'), conn.mux.followOf('a'));

  // B 会话自己的事件正常出现
  conn.mux.followOf('b')!.push(eventFrame(userMsg(5, '在 B 会话说')));
  const msgs = svc.getMessages();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, '在 B 会话说');
  assert.equal(msgs[0].id, 's5');
});

test('未 ready 时 select 先记住，ready 后再挂流', () => {
  const conn = new FakeConn();
  const svc = makeService(conn);
  svc.select('x');
  assert.equal(svc.getActiveSessionId(), 'x');
  assert.equal(conn.mux.opened.length, 0); // 还没 ready，不 attach

  conn.becomeReady([brief('x', 'X', 1)]);
  assert.equal(svc.getActiveSessionId(), 'x'); // 已选中的不被自动覆盖
  // $events（审批，第 1 条）+ x 的 follow（第 2 条）
  assert.equal(conn.mux.opened.length, 2);
  assert.equal(conn.mux.opened[1].endpoint, 'session/follow');
});

test('submit 后先有乐观消息，回声到达后去重', async () => {
  const conn = new FakeConn();
  const svc = makeService(conn);
  conn.becomeReady([brief('a', 'A', 1)]);

  // 拦截 HTTP：prompt 返回 ok
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return {
      ok: true,
      status: 200,
      async json() {
        return { result: { ok: true, value: { accepted: true } } };
      },
      async text() {
        return '';
      },
    } as unknown as Response;
  }) as typeof fetch;
  try {
    await svc.submit('帮我看看');
    // 回声未到：末尾是乐观占位
    const msgs = svc.getMessages();
    const last = msgs[msgs.length - 1];
    assert.equal(last.id, 'optimistic');
    assert.equal(last.text, '帮我看看');
    assert.equal(svc.isRunning(), true);

    // 回声到达（真实 user/message 事件）
    conn.mux.followOf('a')!.push(eventFrame(userMsg(1, '帮我看看')));
    const msgs2 = svc.getMessages();
    assert.equal(msgs2.length, 1); // 不再有乐观占位
    assert.equal(msgs2[0].id, 's1');
    assert.equal(svc.isRunning(), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('stop 调用 session/cancel', async () => {
  const conn = new FakeConn();
  const svc = makeService(conn);
  conn.becomeReady([brief('a', 'A', 1)]);

  let cancelled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/session/cancel')) cancelled = true;
    return {
      ok: true,
      status: 200,
      async json() {
        return { result: { ok: true, value: { accepted: true } } };
      },
      async text() {
        return '';
      },
    } as unknown as Response;
  }) as typeof fetch;
  try {
    await svc.stop();
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('onChange 在状态/消息变化时被通知', () => {
  const conn = new FakeConn();
  const svc = makeService(conn);
  let fired = 0;
  svc.onChange(() => fired++);
  conn.becomeReady([brief('a', 'A', 1)]);
  assert.ok(fired >= 1);
  conn.mux.followOf('a')!.push(eventFrame(userMsg(1, 'hi')));
  assert.ok(fired >= 2);
});
