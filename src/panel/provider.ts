// src/panel/provider.ts — 侧栏 webview 的宿主侧实现。
//
// 职责边界（M0）：只负责「渲染 HTML + 协议握手 + 下发状态快照」。
// 连接 DSH、会话列表、事件流都属于 M1/M2，不要写在这里。
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

import * as vscode from 'vscode';

import {
  PROTOCOL_VERSION,
  initialState,
  isProtocolCompatible,
  mismatchHint,
  type HostMessage,
  type PanelState,
  type UiMessage,
} from './protocol';

export class DshLitePanelProvider implements vscode.WebviewViewProvider {
  /** 与 package.json 的 views 声明保持一致。 */
  static readonly viewId = 'dshLite.panel';

  private view?: vscode.WebviewView;
  private state: PanelState = initialState();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    const outUri = vscode.Uri.joinPath(this.extensionUri, 'out');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [outUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview, outUri);

    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      // webview 是不受信边界：只放行形状正确的消息。
      if (typeof raw !== 'object' || raw === null || typeof (raw as UiMessage).type !== 'string') {
        return;
      }
      this.handleUiMessage(raw as UiMessage);
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });

    this.output.appendLine('[panel] webview 已创建，等待 UI 握手');
  }

  private handleUiMessage(msg: UiMessage): void {
    switch (msg.type) {
      case 'hello': {
        if (!isProtocolCompatible(msg.protocolVersion)) {
          const hint = mismatchHint(msg.protocolVersion);
          const message =
            hint === 'reload' ? '请重载窗口以更新面板' : '面板版本高于扩展，请更新 DSH Lite';
          this.output.appendLine(
            `[panel] 协议版本不匹配：UI=${msg.protocolVersion} 宿主=${PROTOCOL_VERSION} → ${hint}`,
          );
          this.post({ type: 'host/error', code: 'protocol-mismatch', message });
          return;
        }
        this.post({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
        this.postState();
        return;
      }
      case 'ui/ready':
        // UI 挂载完成，补发一次当前快照（握手与挂载顺序不保证）。
        this.postState();
        return;
      case 'ui/refresh':
        // M0 忽略；M1 在此触发与 dsh 的重新连接。
        this.output.appendLine('[panel] 收到 ui/refresh，M0 阶段忽略');
        return;
    }
  }

  private postState(): void {
    this.post({ type: 'host/state', state: this.state });
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview, outUri: vscode.Uri): string {
    const nonce = randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(outUri, 'webview.js'));

    // esbuild 只有在 index.tsx 真的 import 了 css 时才产出 out/webview.css，
    // 不存在就不要引用，避免 webview 里出现 404。
    const cssUri = vscode.Uri.joinPath(outUri, 'webview.css');
    const cssLink = existsSync(cssUri.fsPath)
      ? `<link rel="stylesheet" href="${webview.asWebviewUri(cssUri)}" />`
      : '';

    const csp = [
      "default-src 'none'",
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DSH Lite</title>
    ${cssLink}
    <style nonce="${nonce}">
      html,
      body {
        height: 100%;
      }
      body {
        margin: 0;
        padding: 0;
        background-color: var(--vscode-sideBar-background, var(--vscode-editor-background));
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
      }
      #root {
        display: flex;
        flex-direction: column;
        height: 100%;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
