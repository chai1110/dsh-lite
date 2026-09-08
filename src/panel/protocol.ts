// src/panel/protocol.ts — 宿主(Node) ↔ Webview(UI) 的 postMessage 协议 v1
//
// 设计原则（见 docs/design 与 docs/milestones/M0-脚手架.md）：
// 1. UI 只渲染，不做业务：所有状态由宿主维护，webview 只收快照与增量。
// 2. 协议版本化：UI 启动先 hello 握手，版本不匹配时明确提示，绝不静默降级。
// 3. 本文件是宿主与 UI 的**唯一共享契约**，两侧都从这里 import，禁止各写一份。

/** 协议版本：宿主与 UI 必须一致；不一致时在面板内提示重载/升级。 */
export const PROTOCOL_VERSION = 1;

/** 连接状态：idle=未开始，connecting=连接中，ready=可用，error=出错，offline=断开。 */
export type ConnectionState = 'idle' | 'connecting' | 'ready' | 'error' | 'offline';

/** 会话列表项（数据源 session/list，见 docs/api/remote-mux.md）。 */
export interface SessionBrief {
  sessionId: string;
  /** 取自 projections.values.title，无标题时回退为 sessionId 短串。 */
  title: string;
  updatedAt: number;
  running: boolean;
  cwd?: string;
}

/** 一条渲染用的消息（M2 由事件流填充，M0 恒为空数组）。 */
export interface ViewMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** 是否仍在流式输出中（M2 使用）。 */
  streaming?: boolean;
}

/** 面板完整状态快照：宿主 → UI 全量下发，UI 不做增量合并。 */
export interface PanelState {
  connection: ConnectionState;
  sessions: SessionBrief[];
  activeSessionId: string | null;
  messages: ViewMessage[];
  /** 仅 connection === 'error' 时有值。 */
  error?: { code: string; message: string };
}

/** UI → 宿主。 */
export type UiMessage =
  /** UI 启动后第一条消息，携带自身协议版本。 */
  | { type: 'hello'; protocolVersion: number }
  /** UI 已挂载完成，可以接收状态。 */
  | { type: 'ui/ready' }
  /** 用户点击「重新连接」（M1 使用）。 */
  | { type: 'ui/refresh' };

/** 宿主 → UI。 */
export type HostMessage =
  /** 握手回执，携带宿主协议版本。 */
  | { type: 'hello'; protocolVersion: number }
  /** 状态快照（全量覆盖）。 */
  | { type: 'host/state'; state: PanelState }
  /** 错误提示。 */
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

/** 初始状态（M0 恒为 idle + 空列表）。 */
export function initialState(): PanelState {
  return {
    connection: 'idle',
    sessions: [],
    activeSessionId: null,
    messages: [],
  };
}
