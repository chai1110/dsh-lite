// test/mux.test.ts — mux 客户端：真实 ws 对端（本地 stub 模拟 remote.mux 帧行为）
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

import { MuxClient } from '../src/rpc/mux';

interface ServerRec {
  opened: { streamId: string; endpoint: string; args: Record<string, unknown> }[];
  cancelled: string[];
}

/** 起一个本地「假 remote.mux」：open → 回 item ×2 → 稍后 end；cancel → 记数并回 end */
async function startStubServer() {
  const rec: ServerRec = { opened: [], cancelled: [] };
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const port = (server.address() as AddressInfo).port;

  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      if (msg.type === 'open') {
        const streamId = String(msg.streamId);
        rec.opened.push({
          streamId,
          endpoint: String(msg.endpoint),
          args: (msg.payload as { args: Record<string, unknown> }).args ?? {},
        });
        socket.send(JSON.stringify({ type: 'item', streamId, value: { n: 1 } }));
        socket.send(JSON.stringify({ type: 'item', streamId, value: { n: 2 } }));
        setTimeout(() => socket.send(JSON.stringify({ type: 'end', streamId })), 15);
      } else if (msg.type === 'cancel') {
        rec.cancelled.push(String(msg.streamId));
        socket.send(JSON.stringify({ type: 'end', streamId: String(msg.streamId) }));
      }
    });
  });

  /** 回收：掐掉所有连接并等 server 完全关闭（否则句柄挂着让 node --test 无法退出） */
  const close = () =>
    new Promise<void>((resolve) => {
      for (const c of server.clients) c.terminate();
      server.close(() => resolve());
    });
  return { server, port, rec, close };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('MuxClient', () => {
  it('open → 收 item ×2 → end；payload 带 args 包裹', async () => {
    const stub = await startStubServer();
    const mux = new MuxClient();
    try {
      await mux.connect(`ws://127.0.0.1:${stub.port}/api/remote.mux`, 'dsh-auth-x=1');
      const stream = mux.open('session/control', { _request: {} });

      const items: unknown[] = [];
      stream.onItem((v) => items.push(v));
      const ended = new Promise<void>((r) => stream.onEnd(r));

      await Promise.race([ended, wait(2000)]);
      assert.deepEqual(items, [{ n: 1 }, { n: 2 }]);
      assert.equal(stub.rec.opened.length, 1);
      assert.equal(stub.rec.opened[0].endpoint, 'session/control');
      assert.deepEqual(stub.rec.opened[0].args, { _request: {} });
    } finally {
      mux.close();
      await stub.close();
    }
  });

  it('cancel 会发 cancel 帧（在服务端 end 前取消）', async () => {
    const stub = await startStubServer();
    const mux = new MuxClient();
    try {
      await mux.connect(`ws://127.0.0.1:${stub.port}/api/remote.mux`, 'c=1');
      const stream = mux.open('session/control', {});
      stream.onItem(() => {});
      stream.cancel(); // 立即取消（先于服务端 15ms 后的 end）
      await wait(50);
      assert.equal(stub.rec.cancelled.length, 1);
      assert.equal(stub.rec.cancelled[0], stream.streamId);
    } finally {
      mux.close();
      await stub.close();
    }
  });

  it('对端断开 → onUnexpectedClose 触发', async () => {
    const stub = await startStubServer();
    const mux = new MuxClient();
    try {
      await mux.connect(`ws://127.0.0.1:${stub.port}/api/remote.mux`, 'c=1');
      const unexpected = new Promise<string>((r) => {
        mux.onUnexpectedClose((reason) => r(reason));
      });
      // 服务端主动掐断（模拟 dsh 死亡）
      stub.server.clients.forEach((c) => c.terminate());
      const reason = await Promise.race([unexpected, wait(1500).then(() => 'timeout')]);
      assert.notEqual(reason, 'timeout');
      assert.equal(mux.getState(), 'closed');
    } finally {
      mux.close();
      await stub.close();
    }
  });

  it('主动 close 不触发 onUnexpectedClose', async () => {
    const stub = await startStubServer();
    const mux = new MuxClient();
    try {
      let fired = false;
      mux.onUnexpectedClose(() => {
        fired = true;
      });
      await mux.connect(`ws://127.0.0.1:${stub.port}/api/remote.mux`, 'c=1');
      mux.close();
      await wait(150);
      assert.equal(fired, false);
    } finally {
      await stub.close();
    }
  });

  it('握手超时 → reject（连一个不存在的端口）', async () => {
    const mux = new MuxClient({ connectTimeoutMs: 300 });
    await assert.rejects(mux.connect('ws://127.0.0.1:1/api/remote.mux', 'c=1'));
  });
});
