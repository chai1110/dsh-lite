// test/unary.test.ts — 一元 RPC 的错误形态（守护「错误信息可读」）
//
// 背景：unary 曾抛裸对象 {kind,status,body}，调用方普遍 `catch (err) { String(err) }` 记日志，
// 结果全部退化成 "[object Object]"——把 401 的 token 失效提示（body 里）吞掉，排障瞎飞。
// 本测试锁定「必须是 Error 子类且 String(err) 含 status/body」。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RpcHttpError, unary } from '../src/rpc/unary';

test('HTTP 非 2xx：抛 Error 子类，String(err) 含 status 与 body', async () => {
  const body = 'dsh web authentication required — reopen the URL printed by dsh web';
  const fetchImpl = (async () =>
    new Response(body, { status: 401, statusText: 'Unauthorized' })) as unknown as typeof fetch;

  await assert.rejects(
    () => unary('http://127.0.0.1:1', 'x=1', 'session/list', {}, 1000, fetchImpl),
    (err: unknown) => {
      assert.ok(err instanceof Error, `必须是 Error 实例，实际 ${typeof err}`);
      assert.ok(err instanceof RpcHttpError, '应是 RpcHttpError');
      assert.equal(err.status, 401);
      assert.ok(String(err).includes('401'), `String(err) 应含 status，实际：${String(err)}`);
      assert.ok(
        String(err).includes('reopen the URL'),
        `String(err) 应含 body（排障关键信息），实际：${String(err)}`,
      );
      assert.notEqual(String(err), '[object Object]', '不得退化为 [object Object]');
      return true;
    },
  );
});

test('响应缺 result 字段：同样抛可读的 Error 子类', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ type: 'weird' }), { status: 200 })) as unknown as typeof fetch;

  await assert.rejects(
    () => unary('http://127.0.0.1:1', 'x=1', 'session/list', {}, 1000, fetchImpl),
    (err: unknown) => {
      assert.ok(err instanceof Error, '必须是 Error 实例');
      assert.notEqual(String(err), '[object Object]');
      return true;
    },
  );
});

test('正常响应：返回业务结果', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ result: { ok: true, value: { n: 1 } } }), {
      status: 200,
    })) as unknown as typeof fetch;

  const res = await unary<{ n: number }>('http://127.0.0.1:1', 'x=1', 'session/list', {}, 1000, fetchImpl);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value.n, 1);
});
