// webview/lib/post.ts — 宿主通信入口。
//
// 整个 webview 通过一个 `acquireVsCodeApi()` 实例与宿主通信；这里的 `vscode` 与 `post`
// 是整个 UI 唯一向宿主发言的通道。组件不要直接 `window`/`vscode`。
import type { UiMessage } from '../../src/panel/protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

/** 上行消息：UI 任何动作都通过这里 post 出去。 */
export function post(msg: UiMessage): void {
  vscode.postMessage(msg);
}
