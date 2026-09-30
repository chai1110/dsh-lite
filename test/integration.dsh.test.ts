// test/integration.dsh.test.ts — 真 dsh 端到端（iframe 架构精简版；环境有 dsh 时运行）。
//
// 覆盖：manager 生命周期（自起 → 令牌 → cookie → 代理 200 → 停止）。
// 沙箱结论（2026-09-30 终版）：此前两轮误诊（凭证写锁 → node --test 壳层）均已推翻——
// 真因是**本测试自身的两个 bug**：① `!html.includes('settingsArea')` 断言永假（注入的
// CSS 选择器含该字符串）→ 断言失败后不清理，dsh 子进程挂在事件循环上，runner 永不退出；
// ② `fetch(proxy.baseUrl + '/')` 双斜杠被上游 400。两者已修复（正向断言 + try/finally
// 兜底清理），现**沙箱与真机终端都能完整跑通**：DSH_LITE_E2E=1 npm test
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
    try {
      // ⚠️ 不要写 `${proxy.baseUrl}/`——baseUrl 自带尾斜杠，拼出 `//` 会被上游 400
      const page = await fetch(proxy.baseUrl);
      const html = await page.text();
      assert.equal(page.status, 200, '经代理取首页应 200');
      assert.ok(html.includes('__DSH_BOOT__'), '官方页面应含 boot 数据');
      // 隐藏设置注入的正向断言：注入标记 + 注入的 CSS 规则都在。
      // ⚠️ 不能用 `!html.includes('settingsArea')`——注入的 CSS 选择器本身就含该字符串
      //（曾因此断言必假 → conn.stop() 不执行 → dsh 子进程留在事件循环 → 测试 runner 挂起）。
      assert.ok(html.includes('data-dsh-lite'), '注入应带 data-dsh-lite 标记');
      assert.ok(html.includes('[class*="settingsArea"]{display:none'), '隐藏设置 CSS 规则应存在');

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
    } finally {
      // 任何失败路径都必须停掉自起的 dsh 与代理——否则子进程挂在事件循环上，
      // 测试进程永不退出（node --test 表现为「无输出挂起」）
      await proxy?.stop();
      await conn?.stop();
    }
  });
});
