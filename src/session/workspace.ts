// src/session/workspace.ts — 会话命名与归档（M7）
// 契约实证（0.1.2-rc.1 活体 probe + 装机包类型 dsh-api-session-controller / dsh-api-workspace-controller）：
//   session/rename         → { request: { sessionId, title } } → value { title, seq }
//   workspace/archiveSession   → { request: { sessionId } } → value { archivedSessionIds[] }（归档后全量集合）
//   workspace/unarchiveSession → 同上，把会话移出归档集合
// 归档语义 = 工作区级「隐藏不删」（数据仍在 session/list 全量可见，靠 archivedSessionIds 区分）。
import { isRpcOk, unary } from '../rpc/unary';

export interface SessionApiDeps {
  origin: string;
  cookie: string;
  fetchImpl?: typeof fetch;
}

/** 重命名会话（任意历史会话，不必是当前选中）。失败抛错。 */
export async function renameSession(
  deps: SessionApiDeps,
  sessionId: string,
  title: string,
): Promise<void> {
  const clean = title.trim();
  if (!clean) throw new Error('会话标题不能为空');
  const res = await unary<{ title?: string; seq?: number }>(
    deps.origin,
    deps.cookie,
    'session/rename',
    { request: { sessionId, title: clean } },
    10000,
    deps.fetchImpl,
  );
  if (!isRpcOk(res)) {
    throw new Error(`session/rename 失败: ${res.error.code} ${res.error.message}`);
  }
}

async function mutateArchive(
  deps: SessionApiDeps,
  action: 'archiveSession' | 'unarchiveSession',
  sessionId: string,
): Promise<string[]> {
  const res = await unary<{ archivedSessionIds?: string[] }>(
    deps.origin,
    deps.cookie,
    `workspace/${action}`,
    { request: { sessionId } },
    10000,
    deps.fetchImpl,
  );
  if (!isRpcOk(res)) {
    throw new Error(`workspace/${action} 失败: ${res.error.code} ${res.error.message}`);
  }
  return res.value?.archivedSessionIds ?? [];
}

/** 归档会话：返回归档后的全量 archivedSessionIds（调用方以此同步本地集合）。 */
export async function archiveSession(
  deps: SessionApiDeps,
  sessionId: string,
): Promise<string[]> {
  return mutateArchive(deps, 'archiveSession', sessionId);
}

/** 取消归档：返回取消后的全量 archivedSessionIds。 */
export async function unarchiveSession(
  deps: SessionApiDeps,
  sessionId: string,
): Promise<string[]> {
  return mutateArchive(deps, 'unarchiveSession', sessionId);
}
