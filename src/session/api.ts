// src/session/api.ts — 会话写操作的一元 RPC（M3；字段以契约 §3 + §5 开放问题为准，防御式调用）
import { randomUUID } from 'node:crypto';
import { isRpcOk, unary } from '../rpc/unary';

export interface SessionApiDeps {
  origin: string;
  cookie: string;
  fetchImpl?: typeof fetch;
}

/** 新建会话（cwd = 工作区根）。返回新会话 id；失败抛错。 */
export async function createSession(deps: SessionApiDeps, cwd?: string): Promise<string> {
  const res = await unary<{ sessionId?: string; id?: string }>(
    deps.origin,
    deps.cookie,
    'session/create',
    { request: { ...(cwd ? { cwd } : {}) } },
    10000,
    deps.fetchImpl,
  );
  if (!isRpcOk(res)) {
    throw new Error(`session/create 失败: ${res.error.code} ${res.error.message}`);
  }
  const v = res.value;
  const id = v?.sessionId ?? v?.id;
  if (!id) throw new Error('session/create 未返回 sessionId');
  return id;
}

/** 向会话发送提示。mode: queue=排队 / steer=跟进插入。 */
export async function promptSession(
  deps: SessionApiDeps,
  sessionId: string,
  text: string,
  mode: 'queue' | 'steer',
): Promise<void> {
  const res = await unary<{ accepted?: boolean }>(
    deps.origin,
    deps.cookie,
    'session/prompt',
    {
      request: {
        sessionId,
        requestId: randomUUID(),
        mode,
        content: [{ type: 'text', text }],
      },
    },
    15000,
    deps.fetchImpl,
  );
  if (!isRpcOk(res)) {
    throw new Error(`session/prompt 失败: ${res.error.code} ${res.error.message}`);
  }
}

/** 停止当前生成 */
export async function cancelSession(deps: SessionApiDeps, sessionId: string): Promise<void> {
  const res = await unary<{ accepted?: boolean }>(
    deps.origin,
    deps.cookie,
    'session/cancel',
    { request: { sessionId } },
    10000,
    deps.fetchImpl,
  );
  if (!isRpcOk(res)) {
    throw new Error(`session/cancel 失败: ${res.error.code} ${res.error.message}`);
  }
}
