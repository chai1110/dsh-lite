// src/panel/state.ts — 宿主 → UI 状态快照的合成。
//
// 只做「把连接层 + 服务层 + 配置 + 错误描述」合成 PanelState 推给 UI。
// 不触碰 webview 句柄、不处理消息；上层 provider 负责调它 + postMessage。
import type { ConnectionManager, LiteSnapshot } from '../connection';
import { getConfig } from '../config';
import type { SessionService } from '../session/service';
import { describeErr } from './errors';
import { initialState, type PanelState } from './protocol';

export interface BuildPanelStateDeps {
  snapshot: LiteSnapshot | null;
  conn: ConnectionManager | null;
  service: SessionService | null;
}

/**
 * 把连接/服务快照合成完整的 UI 状态。
 * 缺数据时返回 initialState()；连接出错/断开时附带 error 字段。
 */
export function buildPanelState(deps: BuildPanelStateDeps): PanelState {
  const snap = deps.snapshot ?? deps.conn?.getSnapshot() ?? null;
  if (!snap) return initialState();

  const svc = deps.service;
  const cmd = svc?.getCommandCatalog();
  const state: PanelState = {
    connection: snap.phase,
    // M7：会话列表不再按 cwd 过滤（全部历史，与浏览器一致）；服务层维护归档集合 → 这里打 archived 标记
    sessions: snap.sessions.map((s) =>
      svc && svc.isArchived(s.sessionId) ? { ...s, archived: true } : s,
    ),
    activeSessionId: svc?.getActiveSessionId() ?? null,
    messages: svc?.getMessages() ?? [],
    composerEnterBehavior: getConfig().composerEnterBehavior,
  };
  if (svc) {
    // M6：目标 / 审批 / 斜杠目录（undefined=缺省不渲染，null 见各字段语义）
    state.goal = svc.getGoal();
    state.approval = svc.getPendingApproval();
    if (cmd && cmd.rows !== undefined) state.commands = cmd.rows;
    if (cmd?.error) state.commandsError = cmd.error;
  }
  if (snap.phase === 'error' || snap.phase === 'offline') {
    const code = snap.errorCode ?? 'err.connectionLost';
    state.error = { code, message: describeErr(code) };
  }
  return state;
}
