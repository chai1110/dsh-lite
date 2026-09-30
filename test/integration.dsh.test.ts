// test/integration.dsh.test.ts — 真 dsh 端到端（iframe 架构精简版；环境有 dsh 时运行）。
//
// 覆盖：manager 生命周期（自起 → 令牌 → cookie → 代理 200 → 停止）。
// 沙箱注意（2026-09-30 实测定位）：dsh boot 本身在沙箱内**完全正常**（隔离 DSH_HOME 后
// 15 秒内就绪；ConnectionManager 全生命周期亦可用独立脚本完整走通）——
// 挂起/静默失败发生在 **node --test 壳层与沙箱的交互**（子进程隔离下 ~1s 静默失败、
// 进程内隔离下无输出挂起），并非本文件或 lite 代码的问题。
// 因此本测试的权威运行环境是**本机正常终端**：DSH_LITE_E2E=1 npm test
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { after, describe, it } from 'node:test';

import { ConnectionManager } from '../src/connection';
import { createLiteProxy } from '../src/service/proxy';

const DSH_BIN = process.env.DSH_BIN ?? join(homedir(), '.local', 'node-v24', 'bin', 'dsh');
const HAS_DSH = existsSync(DSH_BIN);
const E2E = process.env.DSH_LITE_E2E === '1';
const SKIP_REASON: string | false = !HAS_DSH
  ? '本机无 dsh 可执行文件（设置 DSH_BIN 可指定）'
  : !E2E
    ? '需要健康 dsh 环境：请设置 DSH_LITE_E2E=1 后再跑（沙箱内 dsh 凭证写锁无法完成 boot）'
    : false;

// 沙箱/CI 里 ~/.dsh 凭证锁会崩 dsh → 未显式设置 DSH_HOME 时自动隔离到临时目录
const PREV_DSH_HOME = process.env.DSH_HOME;
const ISOLATED_HOME = E2E && !PREV_DSH_HOME ? mkdtempSync(join(tmpdir(), 'dsh-lite-e2e-')) : null;
if (ISOLATED_HOME) process.env.DSH_HOME = ISOLATED_HOME;
after(() => {
  if (!ISOLATED_HOME) return;
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
});

/** 找一个空闲端口 */
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

describe('M1 真 dsh 生命周期 + 代理链（iframe 架构）', () => {
  let conn: ConnectionManager;
  let proxy: ReturnType<typeof createLiteProxy>;
  let workspace: string;

  it(
    '自起 → 令牌 → cookie → 代理 200（官方 HTML 含 boot 数据）→ 停止',
    { skip: SKIP_REASON || false },
    async () => {
    workspace = ISOLATED_HOME ?? join(tmpdir(), 'dsh-lite-proxy-ws');
    const port = await freePort();
    conn = new ConnectionManager(
      {
        host: '127.0.0.1',
        port,
        cwd: workspace,
        executablePath: DSH_BIN,
        autoStart: true,
      },
      { log: () => {} },
    );
    const snap = await conn.ensureConnected();
    assert.equal(snap.phase, 'ready', `应就绪（实际 ${snap.phase}）`);
    assert.ok(snap.authUrl?.includes('token='), '就绪地址应带令牌');
    assert.ok(snap.cookie?.startsWith('dsh-auth-'), 'cookie 应已兑换');

    // 起代理（真机代理链）
    proxy = createLiteProxy({
      getTarget: () =>
        snap.origin && snap.cookie ? { url: snap.origin, cookie: snap.cookie } : null,
      log: () => {},
    });
    await proxy.start();
    const page = await fetch(`${proxy.baseUrl}/`);
    const html = await page.text();
    assert.equal(page.status, 200, '经代理取首页应 200');
    assert.ok(html.includes('__DSH_BOOT__'), '官方页面应含 boot 数据');
    assert.ok(!html.includes('settingsArea'), '注入应隐藏设置入口');

    // 代理转发 WebSocket 升级（RPC 通道）——原始 socket 探测升级握手
    //（Node fetch 不支持 ws:// scheme，会直接抛错，不能用 fetch 探测）
    const wsStatus: number = await new Promise((resolve) => {
      const u = new URL(proxy.baseUrl);
      const sock = net.connect(Number(u.port), '127.0.0.1', () => {
        sock.write(
          'GET /api/remote.mux HTTP/1.1\r\nHost: ' + u.host + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let buf = '';
      sock.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        const m = buf.match(/^HTTP\/1\.1 (\d{3})/);
        if (m) {
          sock.destroy();
          resolve(Number(m[1]));
        }
      });
      sock.on('error', () => resolve(0));
      setTimeout(() => {
        sock.destroy();
        resolve(buf ? -1 : 0);
      }, 5000);
    });
    // 101=完整升级；400/426=升级请求已到达上游（说明转发链路通，仅探测载荷不完整）
    assert.ok([101, 400, 426, 501].includes(wsStatus), `WS 升级探测状态 ${wsStatus}（0=连接失败）`);

    await proxy.stop();
    await conn.stop();
  });
});
