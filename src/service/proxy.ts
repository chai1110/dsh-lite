// src/service/proxy.ts — Lite 本地代办代理：webview iframe 只能连代理（跨源 cookie 注入在服务端完成）。
//
// 职责（精简自 dsh-vscode 0.5.4 的同名实现）：
//   1. HTTP 反向代理：注入认证 cookie、剥离浏览器上下文头、流式透传；
//   2. HTML 注入：隐藏官方界面的「设置」入口（Lite 的产品定位：无设置页）；
//   3. WebSocket 升级转发：官方页面的 /api/remote.mux RPC 通道经此直连上游。
import http from 'node:http';
import net from 'node:net';

export interface LiteProxyTarget {
  url: string;
  cookie: string;
}

export interface LiteProxyDeps {
  getTarget: () => LiteProxyTarget | null;
  log?: (line: string) => void;
}

export interface LiteProxy {
  baseUrl: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** 注入到官方页面的样式：隐藏设置入口（Lite 不提供设置页） */
const HIDE_SETTINGS_CSS =
  '<style data-dsh-lite>[class*="settingsArea"]{display:none!important}</style>';

/** 转发上游前剥离的浏览器上下文头（accept-encoding 一并剥离：HTML 注入需要未压缩响应） */
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'cookie',
  'origin',
  'referer',
  'accept-encoding',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
]);

/** 响应侧逐跳头（由 Node 重建） */
const STRIP_RESPONSE_HEADERS = new Set(['transfer-encoding', 'connection']);

/** text/html 响应注入隐藏设置样式（Lite 产品定位：无设置页） */
function injectHideSettings(html: string): string {
  if (html.includes('data-dsh-lite')) return html;
  const lower = html.toLowerCase();
  const headIdx = lower.indexOf('<head>');
  if (headIdx >= 0) {
    const at = headIdx + '<head>'.length;
    return html.slice(0, at) + HIDE_SETTINGS_CSS + html.slice(at);
  }
  return HIDE_SETTINGS_CSS + html;
}

export function createLiteProxy(deps: LiteProxyDeps): LiteProxy {
  let server: import('node:http').Server | null = null;
  let closed = false;
  const state = { port: 0, baseUrl: '' };
  const upgradeClients = new Set<import('node:net').Socket>();

  const handleRequest = (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): void => {
    const target = deps.getTarget();
    if (target === null) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Lite 代办目标未就绪。');
      return;
    }
    const u = new URL(target.url);
    const headers: Record<string, string | string[]> = { host: u.host };
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (STRIP_REQUEST_HEADERS.has(lower) || value === undefined) continue;
      headers[lower] = value;
    }
    headers.cookie = target.cookie;
    const upReq = http.request(
      { hostname: u.hostname, port: u.port === '' ? 80 : Number(u.port), path: req.url ?? '/', method: req.method, headers },
      (upRes) => {
        if (upRes.statusCode === 401) deps.log?.('[proxy] 上游 401（会话失效）');
        const isHtml = (upRes.headers['content-type'] ?? '').toString().includes('text/html');
        const outHeaders: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(upRes.headers)) {
          if (STRIP_RESPONSE_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
          outHeaders[name] = value;
        }
        if (!isHtml) {
          res.writeHead(upRes.statusCode ?? 502, outHeaders);
          upRes.pipe(res);
          return;
        }
        // text/html：缓冲并注入隐藏设置的样式（响应已未压缩——accept-encoding 已剥离；
        // 注入会改变体积，content-length 必须按新体重写）
        const chunks: Buffer[] = [];
        upRes.on('data', (c: Buffer) => chunks.push(c));
        upRes.on('end', () => {
          const body = Buffer.from(injectHideSettings(Buffer.concat(chunks).toString('utf8')), 'utf8');
          outHeaders['content-length'] = String(body.length);
          res.writeHead(upRes.statusCode ?? 502, outHeaders);
          res.end(body);
        });
      },
    );
    upReq.on('error', (err) => {
      deps.log?.(`[proxy] 上游请求失败 ${req.method} ${req.url}: ${String(err)}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`Lite 上游不可达: ${String(err)}`);
      } else {
        res.destroy();
      }
    });
    req.pipe(upReq);
    req.on('error', () => upReq.destroy());
    req.on('close', () => {
      if (!req.readableEnded) upReq.destroy();
    });
  };

  const handleUpgrade = (
    req: import('node:http').IncomingMessage,
    clientSocket: import('node:net').Socket,
    head: Buffer,
  ): void => {
    upgradeClients.add(clientSocket);
    clientSocket.on('close', () => upgradeClients.delete(clientSocket));
    const target = deps.getTarget();
    if (target === null) {
      clientSocket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return;
    }
    const u = new URL(target.url);
    const headers: Record<string, string | string[]> = { host: u.host, connection: 'Upgrade' };
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (lower === 'host' || lower === 'cookie' || lower === 'origin' || lower === 'referer' || lower.startsWith('sec-fetch-')) continue;
      if (value === undefined) continue;
      headers[lower] = value;
    }
    if (req.headers.upgrade !== undefined) headers.upgrade = String(req.headers.upgrade);
    headers.cookie = target.cookie;
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      for (const item of Array.isArray(value) ? value : [String(value)]) lines.push(`${name}: ${item}`);
    }
    const upSocket = net.connect({ host: u.hostname, port: u.port === '' ? 80 : Number(u.port) }, () => {
      upSocket.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length > 0) upSocket.write(head);
      upSocket.pipe(clientSocket);
      clientSocket.pipe(upSocket);
    });
    upSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upSocket.destroy());
  };

  const start = async (): Promise<void> => {
    if (server !== null) return;
    const s = http.createServer(handleRequest);
    s.on('upgrade', handleUpgrade);
    server = s;
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => resolve());
    });
    const address = s.address();
    if (address === null || typeof address === 'string') throw new Error('lite proxy listen 失败');
    if (closed) {
      s.closeAllConnections?.();
      await new Promise<void>((resolve) => s.close(() => resolve()));
      return;
    }
    state.port = address.port;
    state.baseUrl = `http://127.0.0.1:${state.port}/`;
  };

  const stop = async (): Promise<void> => {
    closed = true;
    const s = server;
    server = null;
    for (const sock of upgradeClients) sock.destroy();
    upgradeClients.clear();
    if (s === null) return;
    try {
      s.closeAllConnections?.();
    } catch {
      /* 忽略 */
    }
    await new Promise<void>((resolve) => s.close(() => resolve()));
  };

  return {
    get baseUrl() {
      return state.baseUrl;
    },
    start,
    stop,
  };
}
