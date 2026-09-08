// src/panel/provider.ts — 侧栏 webview 的宿主侧实现。
//
// 职责：渲染 HTML + 协议握手 + 把 ConnectionManager 的快照翻译成 PanelState 下发。
// 连接 DSH 的编排在 src/connection.ts（M1）；消息流/会话窗口在 M2+，不要写在这里。
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

import * as vscode from 'vscode';

import type { ConnectionManager } from '../connection';
import { describeErr } from './errors';
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
  private conn?: ConnectionManager;
  private unsubscribe?: () => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** 在面板首次解析前由扩展入口注入（此时才能拿到工作区上下文） */
  attachConnection(conn: ConnectionManager): void {
    this.conn = conn;
    this.unsubscribe?.();
    this.unsubscribe = conn.onChange(() => {
      this.state = this.toPanelState(conn.getSnapshot());
      this.postState();
    });
  }

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
        // 握手成功即开始连接（autoStart 在 ConnectionManager 内判定）
        if (this.conn) {
          void this.conn.ensureConnected();
        }
        return;
      }
      case 'ui/ready':
        this.postState();
        return;
      case 'ui/refresh':
        this.output.appendLine('[panel] 收到 ui/refresh → 重连');
        if (this.conn) {
          void this.conn.reconnect().then((snap) => {
            this.state = this.toPanelState(snap);
            this.postState();
          });
        }
        return;
    }
  }

  private toPanelState(snap: import('../connection').LiteSnapshot): PanelState {
    const state: PanelState = {
      connection: snap.phase,
      sessions: snap.sessions,
      activeSessionId: null,
      messages: [],
    };
    if (snap.phase === 'error' || snap.phase === 'offline') {
      const code = snap.errorCode ?? 'err.connectionLost';
      state.error = { code, message: describeErr(code) };
    }
    return state;
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
