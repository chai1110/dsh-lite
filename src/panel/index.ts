// src/panel/index.ts — 面板（webview 宿主）模块的公开 API。
//
// 入口只从这里 import：{ DshLitePanelProvider, registerPanelCommands, openChatRight, runViewLocationMigration }
// 内部细节（state/html/protocol/errors）不外漏。
export { DshLitePanelProvider } from './provider';
export { registerPanelCommands, openChatRight } from './commands';
export { runViewLocationMigration } from './migration';
export type { PanelState, HostMessage, UiMessage, ConnectionState } from './protocol';
export { PROTOCOL_VERSION } from './protocol';
