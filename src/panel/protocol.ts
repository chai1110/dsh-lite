// src/panel/protocol.ts — 宿主(Node) ↔ Webview(UI) 的 postMessage 协议 v1
//
// 设计原则（见 docs/design/宿主-UI协议.md 与 docs/milestones/M0-脚手架.md）：
// 1. UI 只渲染，不做业务：所有状态由宿主维护，webview 只收快照与增量。
// 2. 协议版本化：UI 启动先 hello 握手，版本不匹配时明确提示，绝不静默降级。
// 3. 本文件是宿主与 UI 的**唯一共享契约**，两侧都从这里 import，禁止各写一份。
// 4. 跨层模型（SessionBrief/ViewMessage/LiteErrorCode）在 src/model.ts，这里 re-export 保持路径兼容。
import type { ApprovalView, CommandRow, GoalBrief, SessionBrief, ViewMessage } from '../model';

export type { ApprovalView, CommandRow, GoalBrief, SessionBrief, ViewMessage };

/** 协议版本：宿主与 UI 必须一致；不一致时在面板内提示重载/升级。 */
export const PROTOCOL_VERSION = 1;

/** 连接状态：idle=未开始，connecting=连接中，ready=可用，error=出错，offline=断开。 */
export type ConnectionState = 'idle' | 'connecting' | 'ready' | 'error' | 'offline';

/** 面板完整状态快照：宿主 → UI 全量下发，UI 不做增量合并。 */
export interface PanelState {
  connection: ConnectionState;
  sessions: SessionBrief[];
  activeSessionId: string | null;
  messages: ViewMessage[];
  /** 输入框 Enter 行为（缺省 send）。由宿主按 dshLite.composerEnterBehavior 下发（M3）。 */
  composerEnterBehavior?: 'send' | 'newline';
  /** 仅 connection === 'error' | 'offline' 时有值（code 用 err.*，见 docs/api/connection.md §8）。 */
  error?: { code: string; message: string };
  /** 当前会话的目标投影（M6d）；undefined/缺省 = 未知（无控制器），null = 确无目标 */
  goal?: GoalBrief | null;
  /** 当前会话待应答审批（M6c）；null = 无 */
  approval?: ApprovalView | null;
  /** 斜杠命令目录（M6b）；undefined = 未拉取/已关闭，null = 拉取中/失败(见 commandsError)，数组 = 就绪 */
  commands?: CommandRow[] | null;
  /** 命令目录拉取失败的原因（仅 commands === null 时有意义） */
  commandsError?: string | null;
}

/** UI → 宿主。 */
export type UiMessage =
  /** UI 启动后第一条消息，携带自身协议版本。 */
  | { type: 'hello'; protocolVersion: number }
  /** UI 已挂载完成，可以接收状态。 */
  | { type: 'ui/ready' }
  /** 用户点击「重新连接」。 */
  | { type: 'ui/refresh' }
  /** 用户在会话下拉中选中会话（M2）。 */
  | { type: 'ui/selectSession'; sessionId: string }
  /** 用户对某会话重命名（M7）：任意历史会话，不必是当前选中。 */
  | { type: 'ui/sessionRename'; sessionId: string; title: string }
  /** 用户归档某会话（M7）：收进已归档区（隐藏不删，与浏览器同库同步）。 */
  | { type: 'ui/sessionArchive'; sessionId: string }
  /** 用户取消归档某会话（M7）：恢复到当前会话区。 */
  | { type: 'ui/sessionUnarchive'; sessionId: string }
  /** 用户点「＋ 新建」（M3）。 */
  | { type: 'ui/newSession' }
  /** 用户在输入框按 Enter 发送（M3）。宿主侧对 '/xxx' 开头的行分流为斜杠命令执行（M6b）。 */
  | { type: 'ui/promptSubmit'; text: string }
  /** 用户点「停止」（M3）。 */
  | { type: 'ui/stop' }
  /** 输入框出现 '/' 前缀 → 请求拉取当前会话的命令目录（M6b）。 */
  | { type: 'ui/slashQuery'; text: string }
  /** 命令浮层关闭（Esc/失焦/执行后）→ 宿主清掉目录缓存（M6b）。 */
  | { type: 'ui/slashClose' }
  /** 审批卡按钮（M6c）：allowed-once=允许一次 / rejected=拒绝。 */
  | { type: 'ui/approvalAnswer'; eventId: string; outcome: 'allowed-once' | 'rejected' }
  /** 目标 dock 操作（M6d）：pause/resume/clear 走 goals.*；create 用 ui/promptSubmit('/goal …')。 */
  | { type: 'ui/goalAction'; action: 'pause' | 'resume' | 'clear' };

/** 宿主 → UI。 */
export type HostMessage =
  /** 握手回执，携带宿主协议版本。 */
  | { type: 'hello'; protocolVersion: number }
  /** 状态快照（全量覆盖）。 */
  | { type: 'host/state'; state: PanelState }
  /** 握手期致命错误（protocol-mismatch 等一次性提示）。 */
  | { type: 'host/error'; code: string; message: string };

/** 宿主与 UI 的协议版本是否一致。 */
export function isProtocolCompatible(candidate: unknown): boolean {
  return candidate === PROTOCOL_VERSION;
}

/**
 * 版本不一致时的处置建议，供 UI 直接展示。
 * - lower：UI 版本更低 → 通常是 webview 资源缓存，提示重载窗口
 * - higher：UI 版本更高 → 宿主未升级，提示更新扩展
 */
export function mismatchHint(uiVersion: number): 'reload' | 'upgrade' {
  return uiVersion < PROTOCOL_VERSION ? 'reload' : 'upgrade';
}

/** 初始状态（idle + 空列表）。 */
export function initialState(): PanelState {
  return {
    connection: 'idle',
    sessions: [],
    activeSessionId: null,
    messages: [],
  };
}
