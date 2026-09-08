// src/model.ts — 跨层共享模型（host 会话层 / 连接层 / panel 协议共用，纯类型，不依赖 vscode）
// 铁律：本文件只能放纯类型 + 无第三方依赖的纯函数。webview 会 import 它，
// 任何 import 进来 node 内建模块的东西都会炸浏览器 bundle。

/** 会话列表项（数据源 session/list，见 docs/api/remote-mux.md §4.1） */
export interface SessionBrief {
  sessionId: string;
  /** 取自 projections.values.title，无标题时回退为 sessionId 短串 */
  title: string;
  updatedAt: number;
  running: boolean;
  cwd?: string;
  /** M7：是否已归档（派生自 workspace 归档集合，非 session/list 原生字段；仅宿主→UI 下发时有值） */
  archived?: boolean;
}

/** 一条渲染用的消息（M2 由事件流填充；M4/M6 扩展 kind） */
export interface ViewMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** 是否仍在流式输出中 */
  streaming?: boolean;
  /** 渲染块：缺省=文本；tool=工具卡；command=斜杠命令气泡（M6b） */
  kind?: 'text' | 'tool' | 'command';
  /** kind === 'tool' 时的阶段（M4：call 展示命令行，result 可折叠展开） */
  toolState?: 'call' | 'result';
  /** kind === 'command'：command/run↔done 配对后的状态（M6b） */
  cmdState?: 'run' | 'done';
  cmdOk?: boolean;
  resultText?: string;
}

/** 目标相位（与 dsh-goal GoalPhase 对齐） */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';

/** 当前目标的 UI 投影（M6d，来源：goal/change 整快照折叠） */
export interface GoalBrief {
  id: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  maxGoalRounds: number;
  blockedReason?: { code: string; message: string };
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
}

/** 斜杠命令目录里的一行（M6b，来源：commands/list） */
export interface CommandRow {
  name: string;
  description?: string;
  /** 自由输入提示（input.hint）；无 input 的裸命令可直接执行 */
  hint?: string;
}

/** 一次待应答的审批（M6c，来源：$events approval/request 瀑布帧） */
export interface ApprovalView {
  /** 应答时回传的 eventId */
  eventId: string;
  toolName: string;
  callId?: string;
  reason?: string;
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
