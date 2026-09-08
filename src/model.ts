// src/model.ts — 跨层共享模型（host 会话层 / 连接层 / panel 协议共用，纯类型，不依赖 vscode）

/** 会话列表项（数据源 session/list，见 docs/api/remote-mux.md §4.1） */
export interface SessionBrief {
  sessionId: string;
  /** 取自 projections.values.title，无标题时回退为 sessionId 短串 */
  title: string;
  updatedAt: number;
  running: boolean;
  cwd?: string;
}

/** 一条渲染用的消息（M2 由事件流填充） */
export interface ViewMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** 是否仍在流式输出中 */
  streaming?: boolean;
  /** 工具调用等附加渲染块由 M2+ 视图模型按需扩展；先保留扩展位 */
  kind?: 'text' | 'tool' | 'approval' | 'attachment';
}

/** 连接层对外错误 code（err.* 全集见 docs/api/connection.md §8） */
export type LiteErrorCode =
  | 'err.dshNotFound'
  | 'err.nodeNotFound'
  | 'err.spawnEinval'
  | 'err.portOccupied'
  | 'err.startTimeout'
  | 'err.startCrashed'
  | 'err.tokenParse'
  | 'err.cookieExchange'
  | 'err.wsUnreachable'
  | 'err.connectionLost';
