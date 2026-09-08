// test/integration.dsh.test.ts — M1 真 dsh 冒烟（环境有 dsh 时运行；无则 skip）
// 覆盖 docs/api/connection.md §10：自起 → 令牌 → cookie → WS → control 流 → session/list → 杀进程判 offline。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { describe, it } from 'node:test';

import { probeService } from '../src/process/detect';
import { ServiceManager } from '../src/process/manager';
import { createProcessRunner } from '../src/process/process';
import { MuxClient } from '../src/rpc/mux';
import { listSessions } from '../src/session/list';

const DSH_BIN = process.env.DSH_BIN ?? join(homedir(), '.local', 'node-v24', 'bin', 'dsh');
const HAS_DSH = existsSync(DSH_BIN);
// 需要健康 dsh 环境（无凭证锁残留、可完成启动）。沙箱/CI 内 dsh 因内部凭证写锁竞争无法 boot，
// 请在本机终端跑：DSH_LITE_E2E=1 npm test
const E2E = process.env.DSH_LITE_E2E === '1';
const SKIP_REASON = !HAS_DSH
  ? '本机无 dsh 可执行文件（设置 DSH_BIN 可指定）'
  : !E2E
    ? '需要健康 dsh 环境：请设置 DSH_LITE_E2E=1 后再跑（沙箱内 dsh 凭证写锁无法完成 boot）'
    : false;

/** 找一个空闲端口（先 listen(0) 再释放，存在极小竞态，可接受） */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 等 manager 快照满足谓词 */
async function until<T>(fn: () => T | null, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error('until 超时');
    await wait(50);
  }
}

describe('M1 真 dsh 冒烟', () => {
  it(
    '自起→cookie→WS→control 流→session/list→杀进程回 idle',
    { skip: SKIP_REASON, timeout: 90000 },
    async () => {
    const port = await freePort();
    const logs: string[] = [];
    const runner = createProcessRunner();
    const mgr = new ServiceManager(
      { host: '127.0.0.1', port, executablePath: DSH_BIN, autoStart: true, pollMs: 150 },
      {
        probeService,
        processRunner: runner,
        log: (l) => logs.push(l),
        startTimeoutMs: 20000,
      },
    );

    let mux: MuxClient | null = null;
    try {
      const snap = await mgr.ensureRunning();
      assert.equal(snap.state, 'ready', `应 ready，日志：${logs.slice(-8).join('\n')}`);
      assert.ok(snap.authUrl, '应拿到带令牌地址');

      // 令牌换 cookie
      const res = await fetch(snap.authUrl!, { redirect: 'manual' });
      const raw = res.headers.get('set-cookie');
      assert.ok(raw, '应拿到 set-cookie');
      const cookie = raw!.split(';')[0]!.trim();
      const origin = new URL(snap.authUrl!).origin;

      // WS 建连 + control 流（零参数纯流，应至少收到 baseline 帧）
      mux = new MuxClient();
      await mux.connect(`ws://${new URL(origin).host}/api/remote.mux`, cookie);
      const control = mux.open('session/control', {});
      const firstFrame = new Promise<unknown>((resolve) => control.onItem((v) => resolve(v)));
      const v = await Promise.race([firstFrame, wait(8000).then(() => null)]);
      assert.ok(v !== null, 'control 流应推送 baseline 帧');
      const keys = Object.keys(v as Record<string, unknown>);
      assert.ok(keys.includes('baseline'), `baseline 帧应含 baseline 键，实际: ${keys.join(',')}`);

      // session/list 产品化（走 ConnectionManager 同一路径）
      const sessions = await listSessions(origin, cookie);
      assert.ok(Array.isArray(sessions), 'session/list 应返回数组');
      assert.ok(sessions.length > 0, '本机应有至少一个会话');
      assert.ok(sessions[0]?.sessionId, '首项应有 sessionId');

      // 杀进程：manager 应回到 idle（连接层据此判 offline）
      const child = runner.lastChild;
      assert.ok(child, '应有子进程句柄');
      child!.kill('SIGTERM');
      await until(() => (mgr.getSnapshot().state === 'idle' ? true : null));
      assert.equal(mgr.getSnapshot().state, 'idle');
    } finally {
      mux?.close();
      await mgr.stop();
      mgr.dispose();
    }
  },
  );
});
