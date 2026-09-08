// src/process/detect.ts — 端口探测与就绪地址解析（纯模块，不依赖 vscode）
// 移植自 0.5.1 src/service/detect.ts；语义与常量保持不变（详见 docs/api/connection.md §1.1）。
import type { ProbeResult } from './types';

/** DSH 首页的稳定识别特征（首页 HTML 内联 window.__DSH_BOOT__ 启动数据，已实测确认） */
const DSH_MARKER = '__DSH_BOOT__';

/** 新版 dsh（0.1.2 起）web 鉴权 401 响应的固定文案（dsh-client-connection 硬编码，已实测确认） */
const DSH_AUTH_MARKER = 'dsh web authentication required';

export type { ProbeResult };

/**
 * 探测 host:port 上运行的服务：
 * - 200 且首页含 DSH 标记 → 'dsh'（免鉴权旧版，Lite 不复用）
 * - 401/403 且响应体含 dsh 鉴权文案 → 'dsh-auth'（新版，外部实例无法复用）
 * - 有 HTTP 响应但不是 DSH → 'foreign'（端口被其他程序占用）
 * - 连接失败/超时/拒绝 → 'down'（视为未运行）
 */
export async function probeService(
  host: string,
  port: number,
  timeoutMs = 3000,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://${host}:${port}/`, {
      signal: controller.signal,
      redirect: 'manual',
    });
    if (res.status === 401 || res.status === 403) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        /* 响应体读取失败：按非 DSH 处理 */
      }
      return body.includes(DSH_AUTH_MARKER) ? 'dsh-auth' : 'foreign';
    }
    if (!res.ok) return 'foreign';
    const body = await res.text();
    return body.includes(DSH_MARKER) ? 'dsh' : 'foreign';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 dsh web 的启动输出解析就绪地址。
 * 新版 dsh 就绪时打印：`dsh web: http://127.0.0.1:3082/?token=<launchToken> (LAN: …)`
 * 令牌只存在于服务进程内存，外部无法推算——自启实例必须从这行输出取地址。
 */
export function extractDshWebUrl(text: string): string | null {
  const match = /dsh web: (https?:\/\/[^\s)]+)/.exec(text);
  if (!match) return null;
  try {
    return new URL(match[1]).href;
  } catch {
    return null;
  }
}

/** 端口被占用时自动替换的候选尝试次数（从原端口 +1 起依次探测） */
export const PORT_FALLBACK_ATTEMPTS = 50;

/** 从 startPort+1 起依次探测，返回第一个「未运行」的端口号；全部被占/越界返回 null */
export async function findFreePort(
  host: string,
  startPort: number,
  attempts: number,
  probeImpl: (host: string, port: number, timeoutMs?: number) => Promise<ProbeResult> = probeService,
  timeoutMs?: number,
): Promise<number | null> {
  for (let offset = 1; offset <= attempts; offset++) {
    const candidate = startPort + offset;
    if (candidate > 65535) break;
    const result = await probeImpl(host, candidate, timeoutMs);
    if (result === 'down') return candidate;
  }
  return null;
}
