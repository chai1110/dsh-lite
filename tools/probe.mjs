#!/usr/bin/env node
// tools/probe.mjs —— DSH Lite M1 抓帧探针（只读）
//
// 目的：在写任何 UI 之前，用真实 dsh 实例把 RPC 协议摸清楚。
// 本脚本**不做任何写操作**（不发消息、不建会话、不改配置），只连接 + 订阅 + 打印。
//
// 流程：
//   1) 起一个临时的 dsh web 实例（--no-open，不打扰用户）
//   2) 从 stdout 解析带 ?token= 的就绪地址
//   3) 用令牌换 cookie（GET ?token= → 303 → Set-Cookie）
//   4) Node 侧直连 ws://host:port/api/remote.mux（手动带 Cookie，无需代理）
//   5) 打开 session/control 流，打印 baseline 与后续帧
//   6) 打开 session/follow 流，打印 snapshot 与增量帧
//   7) 落盘 JSONL 夹具到 docs/api/fixtures/，退出时杀掉临时实例
//
// 用法：
//   node tools/probe.mjs                      # 自动起实例、抓帧、退出
//   node tools/probe.mjs --port 3199          # 指定端口
//   node tools/probe.mjs --keep               # 抓完不杀实例（便于手动观察）
//   node tools/probe.mjs --only control       # 只抓某个流
//
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ---------------------------------------------------------------- 参数解析
const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const HOST = argOf('host', '127.0.0.1');
const PORT = Number(argOf('port', '0')); // 0 = 让 OS 选
const KEEP = hasFlag('keep');
const ONLY = argOf('only', '');
const WAIT_MS = Number(argOf('wait', '6000'));
const DSH_BIN = argOf('dsh', join(process.env.HOME ?? '', '.local/node-v24/bin/dsh'));

// ---------------------------------------------------------------- ws 模块定位
// 优先用 DSH 自带的 ws（避免给本仓库加运行时依赖）
function loadWebSocket() {
  const candidates = [
    join(process.env.HOME ?? '', '.local/node-v24/lib/node_modules/@deepseek-ai/dsh/node_modules/ws'),
    'ws',
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* 继续尝试下一个 */
    }
  }
  throw new Error('probe: 找不到 ws 模块');
}

const log = (...a) => console.log('[probe]', ...a);
const fail = (msg) => {
  console.error('[probe] 失败:', msg);
  process.exitCode = 1;
};

// ---------------------------------------------------------------- 1) 起实例
function startDsh() {
  return new Promise((resolve, reject) => {
    if (!existsSync(DSH_BIN)) return reject(new Error(`dsh 可执行文件不存在: ${DSH_BIN}`));
    const args = ['--profile', 'web', '--no-open', '--host', HOST, '--port', String(PORT)];
    log('启动:', DSH_BIN, args.join(' '));
    const child = spawn(DSH_BIN, args, {
      env: { ...process.env, PATH: `${join(DSH_BIN, '..')}:${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const m = buf.match(/https?:\/\/[^\s"'<>]+\?[^\s"'<>]*token=[^\s"'<>]+/);
      if (m) {
        child.stdout?.off('data', onData);
        resolve({ child, url: m[0], raw: buf });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (c) => {
      const s = c.toString('utf8').trim();
      if (s) console.error('[dsh:stderr]', s);
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`dsh 提前退出 (code=${code})。输出:\n${buf}`)));
    setTimeout(() => reject(new Error(`等待就绪地址超时 (30s)。输出:\n${buf}`)), 30000).unref?.();
  });
}

// ---------------------------------------------------------------- 2) 令牌换 cookie
async function obtainCookie(tokenUrl) {
  const res = await fetch(tokenUrl, { redirect: 'manual' });
  const raw = res.headers.get('set-cookie');
  log('令牌交换 status =', res.status);
  if (!raw) return null;
  return raw.split(';')[0]?.trim() ?? null;
}

// ---------------------------------------------------------------- 2.5) unary RPC
/**
 * 一元 RPC：POST /api/<method>，信封 { type,rpcId,method,payload:{args} }。
 * 注意：Node 的 fetch 不会自动带 Origin，天然满足 Host 围栏（无需剔除任何头）。
 */
async function unary(baseUrl, cookie, method, args = {}) {
  const res = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------- 3) RPC 客户端
class Mux {
  constructor(url, cookie) {
    this.url = url;
    this.cookie = cookie;
    this.seq = 0;
    this.frames = [];
    this.streams = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const headers = {};
      if (this.cookie) headers.cookie = this.cookie;
      // 注意：绝不发 Origin / Sec-Fetch-Site: cross-site，否则 Host 围栏直接 403
      const ws = new (loadWebSocket())(this.url, { headers });
      this.ws = ws;
      ws.on('open', () => resolve());
      ws.on('unexpected-response', (_req, res) => {
        reject(new Error(`WS 升级被拒: HTTP ${res.statusCode}`));
      });
      ws.on('error', reject);
      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString('utf8'));
        } catch {
          return;
        }
        this.frames.push(msg);
        const sid = msg.streamId;
        if (sid && this.streams.has(sid)) {
          const s = this.streams.get(sid);
          s.items.push(msg);
          if (msg.type === 'end' || msg.type === 'error') s.done(msg);
        }
      });
      // 服务端每 2s ping，漏 2 次即断开；ws 库自动回 pong，无需额外处理
    });
  }
  /** 打开一个流并收集帧。
   *  注意：payload 必须是 { args: <plain object> } —— 网关 remoteRequest() 强制校验
   *  "exactly one plain-object args field"，直接传参数对象会被拒（gateway/internal）。 */
  open(endpoint, args = {}, { waitMs = WAIT_MS, maxItems = 50 } = {}) {
    const streamId = `s${++this.seq}`;
    const rec = { endpoint, streamId, items: [] };
    this.streams.set(streamId, rec);
    let timer;
    const done = new Promise((resolve) => {
      rec.done = resolve;
      timer = setTimeout(resolve, waitMs);
    });
    this.ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
    return done.then((last) => {
      clearTimeout(timer);
      if (rec.items.length > maxItems) rec.items.length = maxItems; // 只留前 N 帧做夹具
      return { endpoint, streamId, last: last?.type ?? 'timeout', items: rec.items };
    });
  }
  close() {
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
  }
}

// ---------------------------------------------------------------- 主流程
async function main() {
  if (!existsSync(DSH_BIN)) return fail(`找不到 dsh: ${DSH_BIN}（用 --dsh 指定）`);

  const { child, url } = await startDsh();
  log('就绪地址:', url);

  const cookie = await obtainCookie(url);
  if (!cookie) {
    child.kill('SIGTERM');
    return fail('令牌交换未拿到 cookie');
  }
  log('拿到 cookie:', cookie.slice(0, 24) + '…');

  const wsUrl = `ws://${new URL(url).host}/api/remote.mux`;
  const mux = new Mux(wsUrl, cookie);
  try {
    await mux.connect();
  } catch (e) {
    child.kill('SIGTERM');
    return fail(`WS 连接失败: ${e.message}`);
  }
  log('WS 已连接:', wsUrl);

  const baseUrl = new URL(url).origin;
  const results = {};

  // ---- session/control：运行态与投影流（零参数纯流；不承载会话清单）
  if (!ONLY || ONLY === 'control') {
    const r = await mux.open('session/control', {}, { waitMs: 4000 });
    results.control = r;
    log(`control: ${r.items.length} 帧, 末帧类型=${r.last}`);
  }

  // ---- session/list（unary）：真正的会话清单
  let sessionId = null;
  if (!ONLY || ONLY === 'list' || ONLY === 'follow') {
    const r = await unary(baseUrl, cookie, 'session/list', { _request: {} });
    results.list = r;
    log(`session/list: HTTP ${r.status}`);
    const value = r.body?.result?.value;
    if (r.body?.result?.ok === false) {
      log('session/list 业务错误:', JSON.stringify(r.body.result.error).slice(0, 300));
    } else if (value) {
      const arr = Array.isArray(value) ? value : (value.sessions ?? value.items ?? []);
      log(`session/list 返回 ${arr.length} 项；顶层键 = ${Object.keys(value).join(',')}`);
      if (arr[0]) log('首项键 =', Object.keys(arr[0]).join(','));
      sessionId = arr.map((s) => s?.sessionId ?? s?.id).find(Boolean) ?? null;
    }
  }

  // ---- session/follow：订阅第一个会话的事件流
  if ((!ONLY || ONLY === 'follow') && sessionId) {
    log('订阅会话:', sessionId);
    const r = await mux.open(
      'session/follow',
      { request: { address: { kind: 'session', sessionId } } },
      { waitMs: 5000 },
    );
    results.follow = r;
    log(`follow: ${r.items.length} 帧, 末帧类型=${r.last}`);
  }

  // ---- 落盘夹具
  const outDir = join(ROOT, 'docs/api/fixtures');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(outDir, `probe-${stamp}.jsonl`);
  await writeFile(file, results ? JSON.stringify(results, null, 2) : '', 'utf8');
  log('夹具已写入:', file);

  // ---- 摘要打印
  console.log('\n===== 帧摘要 =====');
  for (const [k, r] of Object.entries(results)) {
    // 流结果：{ items: [...] }；unary 结果：{ status, body }
    if (!Array.isArray(r.items)) {
      console.log(`\n--- ${k} (unary) ---`);
      console.log('  HTTP', r.status, JSON.stringify(r.body).slice(0, 600));
      continue;
    }
    console.log(`\n--- ${k} (${r.items.length} 帧) ---`);
    for (const it of r.items.slice(0, 6)) {
      const v = it.value;
      const brief =
        v === undefined
          ? ''
          : Array.isArray(v)
            ? `Array(${v.length})`
            : typeof v === 'object' && v !== null
              ? Object.keys(v).join(',')
              : String(v);
      console.log(`  [${it.type}] ${typeof v === 'object' && v?.type ? v.type : ''}: ${brief.slice(0, 200)}`);
    }
  }

  mux.close();
  if (!KEEP) {
    log('停止临时实例 pid =', child.pid);
    child.kill('SIGTERM');
  } else {
    log('--keep：实例保留，pid =', child.pid, '地址:', url);
  }
}

main().catch((e) => fail(e.stack ?? e.message));
