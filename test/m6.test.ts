// test/m6.test.ts — M6 单测：斜杠命令分流与执行、命令目录、目标折叠与动作、$events 审批应答
// 用 FakeConn + FakeMux 替身（同 service.test.ts 约定）：不碰真实网络（HTTP 侧用 fetch 桩）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionService } from '../src/session/service';
import { SessionViewModel } from '../src/session/viewmodel';
import type { SessionBrief } from '../src/model';
import type { ConnectionManager, LiteSnapshot } from '../src/connection';
import type { MuxClient, MuxStream } from '../src/rpc/mux';
import type { RawEvent } from '../src/session/events';

// ---------- fakes（与 service.test.ts 同构） ----------
class FakeStream implements MuxStream<unknown> {
  readonly streamId: string;
  private itemCbs: Array<(v: unknown) => void> = [];
  private endCbs: Array<() => void> = [];
  private errCbs: Array<(e: { code: string; message: string }) => void> = [];
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
  cancel(): void {}
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
  streamByEndpoint(endpoint: string): FakeStream | null {
    return this.opened.find((o) => o.endpoint === endpoint)?.stream ?? null;
  }
}

class FakeConn {
  phase: 'idle' | 'ready' | 'offline' | 'error' = 'idle';
  origin = 'http://127.0.0.1:3082';
  cookie = 'dsh-auth-token';
  sessions: SessionBrief[] = [];
  mux = new FakeMux();
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
  async refreshSessions(): Promise<void> {}
  becomeReady(sessions: SessionBrief[]): void {
    this.phase = 'ready';
    this.sessions = sessions;
    this.emit();
  }
  /** 测试用：连接断开（offline/error），广播快照 */
  become(phase: 'offline' | 'error'): void {
    this.phase = phase;
    this.emit();
  }
  private emit(): void {
    const snap = this.getSnapshot();
    for (const cb of this.listeners) cb(snap);
  }
}

function brief(id: string): SessionBrief {
  return { sessionId: id, title: id, updatedAt: 0, running: false };
}

function makeService(conn: FakeConn, lines: string[]): SessionService {
  return new SessionService(conn as unknown as ConnectionManager, {
    log: (l) => lines.push(l),
    followUpMode: 'queue',
  });
}

/** 模块级保存原始 fetch，stub 用完即还原 */
let origFetch: typeof fetch | undefined;

/** 给测试期装一个 HTTP 桩：把 /api/<method> 的 unary 记下来并返回可控 rpc 结果 */
function stubFetch(
  calls: string[],
  respond: (method: string) => { ok: boolean; value?: unknown; error?: { code: string; message: string } },
): void {
  origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const method = url.split('/api/')[1] ?? url;
    const res = respond(method);
    const payload = res.ok
      ? { type: 'rpc-response', rpcId: 'x', result: { ok: true, value: res.value } }
      : { type: 'rpc-response', rpcId: 'x', result: { ok: false, error: res.error } };
    calls.push(url);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}
function restoreFetch(): void {
  if (origFetch) globalThis.fetch = origFetch;
  origFetch = undefined;
}

function evt(partial: Partial<RawEvent> & { type: string; seq: number }): RawEvent {
  return { type: partial.type, seq: partial.seq, data: partial.data };
}

// ---------- viewmodel：command 配对 / goal 折叠 ----------
test('command/run 渲染命令气泡，command/done 按 commandId 配对收口', () => {
  const vm = new SessionViewModel();
  vm.applyEvent(evt({ type: 'command/run', seq: 1, data: { commandId: 'c1', name: 'goal', args: ' 跑 5 公里' } }));
  let s = vm.getState();
  assert.equal(s.entries[0].kind, 'command');
  assert.equal(s.entries[0].cmdState, 'run');
  assert.equal(s.entries[0].text, '/goal 跑 5 公里');

  vm.applyEvent(evt({ type: 'command/done', seq: 2, data: { commandId: 'c1', kind: 'success', text: '已创建' } }));
  s = vm.getState();
  assert.equal(s.entries.length, 1); // 配对成功：不新增条目
  assert.equal(s.entries[0].cmdState, 'done');
  assert.equal(s.entries[0].cmdOk, true);
  assert.equal(s.entries[0].resultText, '已创建');
});

test('command/done 无配对 run（快照截断）时兜底独立条目', () => {
  const vm = new SessionViewModel();
  vm.applyEvent(evt({ type: 'command/done', seq: 1, data: { commandId: 'zz', kind: 'error', text: '失败' } }));
  const s = vm.getState();
  assert.equal(s.entries.length, 1);
  assert.equal(s.entries[0].kind, 'command');
  assert.equal(s.entries[0].cmdState, 'done');
  assert.equal(s.entries[0].cmdOk, false);
});

test('goal/change 折叠为当前目标投影（整快照语义）并保留状态行', () => {
  const vm = new SessionViewModel();
  vm.applyEvent(
    evt({
      type: 'goal/change',
      seq: 1,
      data: {
        kind: 'goal/change',
        version: 1,
        operation: 'create',
        goal: { id: 'g1', revision: 1, objective: '跑 5 公里', phase: 'active', maxGoalRounds: 5 },
        roundsStarted: 0,
        createdAt: 10,
        updatedAt: 11,
      },
    }),
  );
  const goal = vm.getGoal();
  assert.ok(goal);
  assert.equal(goal.id, 'g1');
  assert.equal(goal.objective, '跑 5 公里');
  assert.equal(goal.phase, 'active');
  assert.equal(goal.revision, 1);
  // 状态行保留（历史可读）
  assert.ok(vm.getState().entries.some((e) => e.kind === 'status' && e.text === '目标已更新'));
});

test('goal/change clear 墓碑清空投影；reset 也清空', () => {
  const vm = new SessionViewModel();
  vm.applyEvent(
    evt({
      type: 'goal/change',
      seq: 1,
      data: { kind: 'goal/change', version: 1, operation: 'create', goal: { id: 'g1', revision: 1, objective: 'x', phase: 'active', maxGoalRounds: 3 }, roundsStarted: 0, createdAt: 1, updatedAt: 2 },
    }),
  );
  assert.ok(vm.getGoal());
  vm.applyEvent(
    evt({ type: 'goal/change', seq: 2, data: { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'g1', revision: 2 }, clearedAt: 5 } }),
  );
  assert.equal(vm.getGoal(), null);

  // reset 后再次创建 → 可重建
  vm.reset();
  assert.equal(vm.getGoal(), null);
});

// ---------- service：斜杠分流 / 目录 / 审批 / 目标动作 ----------
test('submit 以 / 开头 → commands/execute（不设乐观占位）', async () => {
  const conn = new FakeConn();
  const lines: string[] = [];
  const svc = makeService(conn, lines);
  conn.becomeReady([brief('s1')]);
  const calls: string[] = [];
  stubFetch(calls, (m) => {
    if (m === 'commands/execute') return { ok: true, value: { commandId: 'c9', result: { kind: 'success', text: 'ok' } } };
    return { ok: false, error: { code: 'x', message: 'unexpected' } };
  });
  try {
    await svc.submit('/help');
    assert.ok(calls.some((u) => u.endsWith('/api/commands/execute')));
    assert.equal(svc.getMessages().length, 0); // 无乐观 user 气泡（命令气泡由事件驱动）
  } finally {
    restoreFetch();
  }
});

test('openSlash 拉取命令目录并映射 CommandRow', async () => {
  const conn = new FakeConn();
  const svc = makeService(conn, []);
  conn.becomeReady([brief('s1')]);
  const calls: string[] = [];
  stubFetch(calls, (m) => {
    if (m === 'commands/list')
      return {
        ok: true,
        value: [
          { name: 'goal', description: '设定/更新目标', input: { hint: 'objective…' } },
          { name: 'clear', description: '清空会话' },
        ],
      };
    return { ok: false, error: { code: 'x', message: 'unexpected' } };
  });
  try {
    await svc.openSlash();
    const { rows, error } = svc.getCommandCatalog();
    assert.equal(error, null);
    assert.deepEqual(rows, [
      { name: 'goal', description: '设定/更新目标', hint: 'objective…' },
      { name: 'clear', description: '清空会话' },
    ]);
    svc.closeSlash();
    assert.equal(svc.getCommandCatalog().rows, undefined);
  } finally {
    restoreFetch();
  }
});

test('$events 审批瀑布：ready→waterfall→应答($events/result)→cancel', async () => {
  const conn = new FakeConn();
  const svc = makeService(conn, []);
  conn.becomeReady([brief('s1')]);
  const evStream = conn.mux.streamByEndpoint('$events');
  assert.ok(evStream, '$events 流已挂');
  evStream.push({ type: 'ready', clientId: 'client-1', host: { home: '/tmp' } });
  evStream.push({
    type: 'waterfall',
    event: 'approval/request',
    eventId: 'evt-1',
    agentId: 's1',
    request: { toolName: 'dangerous_tool', reason: '要跑高危命令' },
  });
  let pending = svc.getPendingApproval();
  assert.ok(pending);
  assert.equal(pending.eventId, 'evt-1');
  assert.equal(pending.toolName, 'dangerous_tool');
  assert.equal(pending.reason, '要跑高危命令');

  // 应答：开 $events/result 流（需 end 才算完成）
  const answering = svc.answerApproval('evt-1', 'allowed-once');
  const resultStream = conn.mux.streamByEndpoint('$events/result');
  assert.ok(resultStream, '应答流已开');
  const args = (conn.mux.opened.find((o) => o.endpoint === '$events/result')?.payload ?? {}) as Record<string, unknown>;
  assert.deepEqual(args, { clientId: 'client-1', eventId: 'evt-1', outcome: { kind: 'result', value: 'allowed-once' } });
  resultStream.end();
  await answering;
  assert.equal(svc.getPendingApproval(), null); // 本地已移除（幂等，等 cancel）

  // cancel 帧到达也无副作用
  evStream.push({ type: 'cancel', eventId: 'evt-1' });
  assert.equal(svc.getPendingApproval(), null);
});

test('断开连接清空待批审批（防 WS 重连后陈旧审批卡残留）', () => {
  const conn = new FakeConn();
  const svc = makeService(conn, []);
  conn.becomeReady([brief('s1')]);
  const evStream = conn.mux.streamByEndpoint('$events');
  assert.ok(evStream);
  evStream.push({ type: 'ready', clientId: 'client-1', host: { home: '/tmp' } });
  evStream.push({
    type: 'waterfall',
    event: 'approval/request',
    eventId: 'evt-9',
    agentId: 's1',
    request: { toolName: 'shell', reason: '旧代次待批' },
  });
  assert.ok(svc.getPendingApproval(), '断开前有待批');

  conn.become('offline');
  assert.equal(svc.getPendingApproval(), null, '断开后待批清空（重连由网关对新 $events 代次重推）');

  // 重连后同一 eventId 的瀑布可再次入列（幂等重建）：取「最新」的 $events 流（旧流已被 hub.close 取消）
  conn.becomeReady([brief('s1')]);
  const ev2 = [...conn.mux.opened].reverse().find((o) => o.endpoint === '$events')?.stream ?? null;
  assert.ok(ev2 && ev2 !== evStream, '重连后是新 $events 流');
  ev2.push({ type: 'ready', clientId: 'client-2', host: { home: '/tmp' } });
  ev2.push({
    type: 'waterfall',
    event: 'approval/request',
    eventId: 'evt-9',
    agentId: 's1',
    request: { toolName: 'shell', reason: '新代次重推' },
  });
  const pending = svc.getPendingApproval();
  assert.ok(pending && pending.eventId === 'evt-9', '重推后可再次应答');
});

test('goalAction(pause) 走 goals/pause HTTP 并携带当前 ref', async () => {
  const conn = new FakeConn();
  const lines: string[] = [];
  const svc = makeService(conn, lines);
  conn.becomeReady([brief('s1')]);
  // 喂 goal/change 让投影就绪
  const follow = conn.mux.streamByEndpoint('session/follow');
  assert.ok(follow);
  follow.push({
    type: 'event',
    event: evt({
      type: 'goal/change',
      seq: 1,
      data: { kind: 'goal/change', version: 1, operation: 'create', goal: { id: 'g1', revision: 3, objective: '跑 5 公里', phase: 'active', maxGoalRounds: 5 }, roundsStarted: 1, createdAt: 1, updatedAt: 2 },
    }),
  });
  const goal = svc.getGoal();
  assert.ok(goal && goal.id === 'g1');

  const calls: string[] = [];
  stubFetch(calls, (m) => {
    if (m === 'goals/pause') return { ok: true, value: {} };
    return { ok: false, error: { code: 'x', message: 'unexpected' } };
  });
  try {
    await svc.goalAction('pause');
    assert.ok(calls.some((u) => u.endsWith('/api/goals/pause')));
  } finally {
    restoreFetch();
  }
});
