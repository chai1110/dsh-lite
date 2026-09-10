// src/session/list.ts — session/list（unary）产品化 + cwd 客户端过滤
// 契约见 docs/api/remote-mux.md §3/§4.1；cwd 过滤规则见 03-UI规格「工作区归属」。
import type { SessionBrief } from '../model';
import { isRpcOk, unary } from '../rpc/unary';

/** session/list 原始项（契约快照 §4.1，字段超集只取需要的） */
export interface SessionRaw {
  sessionId: string;
  updatedAt?: number;
  running?: boolean;
  blank?: boolean;
  cwd?: string;
  projections?: { values?: { title?: string | null } };
}

interface ListResponse {
  items?: SessionRaw[];
  sessions?: SessionRaw[];
}

const shortId = (id: string): string => id.replace(/^session-/, '').slice(0, 8);

/** 拉取全部会话（最新在前）。入参只有 {cursor?}，本实现取第一页全量（与 probe 一致）。 */
export async function listSessions(
  origin: string,
  cookie: string,
  fetchImpl?: typeof fetch,
): Promise<SessionBrief[]> {
  const res = await unary<ListResponse>(origin, cookie, 'session/list', { _request: {} }, 10000, fetchImpl);
  if (!isRpcOk(res)) {
    throw new Error(`session/list 业务错误: ${res.error.code} ${res.error.message}`);
  }
  const raw = res.value?.items ?? res.value?.sessions ?? [];
  return raw
    .filter((s) => Boolean(s.sessionId))
    .map((s): SessionBrief => ({
      sessionId: s.sessionId,
      // 空白标题（"   "/"\n"）是真值，`||` 不会兜底 → 历史下拉会出现无法辨识的空白行，故先 trim
      title: s.projections?.values?.title?.trim() || shortId(s.sessionId),
      updatedAt: s.updatedAt ?? 0,
      running: Boolean(s.running),
      ...(s.cwd ? { cwd: s.cwd } : {}),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * cwd 客户端过滤（决策 3）：
 * - cwd 传入（有工作区打开）：只保留 cwd 与 workspaceRoot 相等/以其为前缀的会话（含子目录场景）
 * - cwd 缺省（无工作区）：返回全部
 */
export function filterSessionsByCwd(sessions: SessionBrief[], workspaceRoot?: string): SessionBrief[] {
  if (!workspaceRoot) return sessions;
  const root = workspaceRoot.endsWith('/') || workspaceRoot.endsWith('\\') ? workspaceRoot : workspaceRoot + '/';
  return sessions.filter((s) => {
    if (!s.cwd) return false;
    return s.cwd === workspaceRoot || s.cwd.startsWith(root);
  });
}

/** 取 cwd 的末段用于无工作区时的标注（如 /a/b/c → c） */
export function cwdTail(cwd?: string): string {
  if (!cwd) return '';
  const norm = cwd.replace(/[\\/]+$/, '');
  const seg = norm.split(/[\\/]/);
  return seg[seg.length - 1] ?? norm;
}
