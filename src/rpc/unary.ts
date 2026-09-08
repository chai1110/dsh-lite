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

export interface RpcHttpError {
  kind: 'http';
  status: number;
  body: string;
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
    throw { kind: 'http', status: res.status, body: await res.text().catch(() => '') } satisfies UnaryError;
  }
  const body = (await res.json()) as { type?: string; rpcId?: string; result?: RpcResult<T> };
  const result = body.result;
  if (!result) {
    throw { kind: 'http', status: res.status, body: JSON.stringify(body).slice(0, 500) } satisfies UnaryError;
  }
  return result;
}

/** 业务错误简写：ok=false 时返回其中的 error（无 details 展开） */
export function isRpcOk<T>(r: RpcResult<T>): r is { ok: true; value: T } {
  return r.ok === true;
}
