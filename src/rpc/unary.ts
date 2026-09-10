// src/rpc/unary.ts — 一元 HTTP RPC：POST /api/<ns>/<method>
// 信封见 docs/api/remote-mux.md §2.2。Node 的 fetch 不带 Origin，天然满足 Host 围栏（§2.3）。
import { randomUUID } from 'node:crypto';

export interface RpcEnvelope {
  type: 'client-request';
  rpcId: string;
  method: string;
  payload: { args: Record<string, unknown> };
}

export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

/**
 * HTTP 层错误。必须是 Error 子类：调用方普遍用 `catch (err) { String(err) }` 记日志，
 * 若抛裸对象会退化为 "[object Object]"，把 status/body（含 401 的 token 失效提示）全部吞掉。
 */
export class RpcHttpError extends Error {
  readonly kind = 'http' as const;
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`RPC HTTP ${status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    this.name = 'RpcHttpError';
  }
}

export type UnaryError = RpcHttpError;

export async function unary<T = unknown>(
  origin: string,
  cookie: string,
  method: string,
  args: Record<string, unknown> = {},
  timeoutMs = 10000,
  fetchImpl: typeof fetch = fetch,
): Promise<RpcResult<T>> {
  const envelope: RpcEnvelope = { type: 'client-request', rpcId: randomUUID(), method, payload: { args } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new RpcHttpError(res.status, await res.text().catch(() => ''));
  }
  const body = (await res.json()) as { type?: string; rpcId?: string; result?: RpcResult<T> };
  const result = body.result;
  if (!result) {
    throw new RpcHttpError(res.status, JSON.stringify(body).slice(0, 500));
  }
  return result;
}

/** 业务错误简写：ok=false 时返回其中的 error（无 details 展开） */
export function isRpcOk<T>(r: RpcResult<T>): r is { ok: true; value: T } {
  return r.ok === true;
}
