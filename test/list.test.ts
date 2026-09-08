// test/list.test.ts — session/list 映射 + cwd 客户端过滤
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cwdTail, filterSessionsByCwd, listSessions } from '../src/session/list';
import type { SessionRaw } from '../src/session/list';

/** 假 fetch：捕获请求、按需返回 unary 响应 */
function fakeFetchReturning(items: SessionRaw[]) {
  const calls: { url: string; body: unknown }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return {
      ok: true,
      status: 200,
      json: async () => ({ type: 'server-response', result: { ok: true, value: { items } } }),
      text: async () => '',
    } as unknown as Response;
  }) as typeof fetch;
  return { impl, calls };
}

describe('listSessions', () => {
  it('映射 + 排序（最新在前）+ title 回退', async () => {
    const raw: SessionRaw[] = [
      { sessionId: 'session-aaa', updatedAt: 100, running: true, cwd: '/ws',
        projections: { values: { title: '标题 A' } } },
      { sessionId: 'session-bbb', updatedAt: 300, running: false },
      { sessionId: 'session-ccc', updatedAt: 200, cwd: '/other' },
    ];
    const { impl, calls } = fakeFetchReturning(raw);
    const sessions = await listSessions('http://127.0.0.1:3082', 'dsh-auth-x=1', impl);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:3082/api/session/list');
    const envelope = calls[0].body as { type: string; method: string; payload: { args: unknown } };
    assert.equal(envelope.type, 'client-request');
    assert.equal(envelope.method, 'session/list');
    assert.deepEqual(envelope.payload.args, { _request: {} });

    assert.equal(sessions.length, 3);
    assert.deepEqual(sessions.map((s) => s.sessionId), ['session-bbb', 'session-ccc', 'session-aaa']);
    assert.equal(sessions[0].title, 'bbb'); // 无标题 → sessionId 去掉前缀后的短串
    assert.equal(sessions[2].title, '标题 A');
    assert.equal(sessions[0].running, false);
    assert.equal(sessions[2].cwd, '/ws');
  });

  it('业务错误 → throw', async () => {
    const impl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: { ok: false, error: { code: 'x', message: 'boom' } } }),
      text: async () => '',
    })) as unknown as typeof fetch;
    await assert.rejects(listSessions('http://x', 'c=1', impl), /boom/);
  });
});

describe('filterSessionsByCwd', () => {
  const s = (id: string, cwd?: string) => ({ sessionId: id, title: id, updatedAt: 0, running: false, ...(cwd ? { cwd } : {}) });

  it('有工作区根 → 只留匹配（含子目录前缀）', () => {
    const all = [s('1', '/ws'), s('2', '/ws/sub'), s('3', '/other'), s('4', '/wsx')];
    const got = filterSessionsByCwd(all, '/ws');
    assert.deepEqual(got.map((x) => x.sessionId), ['1', '2']);
  });

  it('无工作区根 → 全显', () => {
    const all = [s('1', '/a'), s('2')];
    assert.equal(filterSessionsByCwd(all, undefined).length, 2);
  });

  it('cwdTail', () => {
    assert.equal(cwdTail('/Users/csl/Documents/dsh_data'), 'dsh_data');
    assert.equal(cwdTail('C:\\Users\\csl\\ws'), 'ws');
    assert.equal(cwdTail(undefined), '');
  });
});
