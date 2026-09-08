// src/panel/provider.ts — 侧栏 webview 的宿主侧实现。
//
// 职责：渲染 HTML + 协议握手 + 把「连接快照 + 会话服务」合成 PanelState 下发。
// 连接编排在 src/connection.ts，会话窗口/发送在 src/session/service.ts。
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

import * as vscode from 'vscode';

import type { ConnectionManager, LiteSnapshot } from '../connection';
import type { SessionService } from '../session/service';
import { getConfig } from '../config';
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
  static readonly viewId = 'dshLite.panel';
  /** M8：右侧（次要）侧栏中的视图；与左侧视图共用同一 provider 实例与会话 */
  static readonly viewIdSecondary = 'dshLite.panel.secondary';

  /** 当前存活的 webview 视图，按 viewType(=viewId) 索引：左侧栏与右侧栏可并存 */
  private readonly views = new Map<string, vscode.WebviewView>();
  private state: PanelState = initialState();
  private conn?: ConnectionManager;
  private service?: SessionService;
  private unsubConn?: () => void;
  private unsubSvc?: () => void;
  private snapshot: LiteSnapshot | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** 在面板首次解析前由扩展入口注入 */
  attachConnection(conn: ConnectionManager, service: SessionService): void {
    this.conn = conn;
    this.service = service;
    this.unsubConn?.();
    this.unsubConn = conn.onChange((snap) => {
      this.snapshot = snap;
      this.publish();
    });
    this.unsubSvc?.();
    this.unsubSvc = service.onChange(() => this.publish());
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    const viewType = webviewView.viewType;
    this.views.set(viewType, webviewView);
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
      this.views.delete(viewType);
    });

    this.output.appendLine(`[panel:${viewType}] webview 已创建，等待 UI 握手`);
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
        this.publish();
        if (this.conn) void this.conn.ensureConnected();
        return;
      }
      case 'ui/ready':
        this.publish();
        return;
      case 'ui/refresh':
        if (this.conn) {
          void this.conn.reconnect().then((snap) => {
            this.snapshot = snap;
            this.publish();
          });
        }
        return;
      case 'ui/selectSession':
        this.output.appendLine(`[panel] 切换会话: ${msg.sessionId}`);
        this.service?.select(msg.sessionId);
        return;
      case 'ui/sessionRename':
        if (this.service) {
          void this.service.renameSession(msg.sessionId, msg.title).catch((err) =>
            this.output.appendLine(`[panel] 会话改名失败: ${String(err)}`),
          );
        }
        return;
      case 'ui/sessionArchive':
        if (this.service) {
          void this.service.archiveSession(msg.sessionId).catch((err) =>
            this.output.appendLine(`[panel] 归档失败: ${String(err)}`),
          );
        }
        return;
      case 'ui/sessionUnarchive':
        if (this.service) {
          void this.service.unarchiveSession(msg.sessionId).catch((err) =>
            this.output.appendLine(`[panel] 取消归档失败: ${String(err)}`),
          );
        }
        return;
      case 'ui/newSession':
        if (this.service) {
          void this.service.create().catch((err) => this.output.appendLine(`[panel] 新建失败: ${String(err)}`));
        }
        return;
      case 'ui/promptSubmit': {
        if (this.service) {
          void this.service.submit(msg.text).catch((err) =>
            this.output.appendLine(`[panel] 发送失败: ${String(err)}`),
          );
        }
        return;
      }
      case 'ui/stop':
        if (this.service) void this.service.stop();
        return;
      case 'ui/slashQuery':
        if (this.service) {
          void this.service.openSlash().catch((err) =>
            this.output.appendLine(`[panel] 命令目录拉取失败: ${String(err)}`),
          );
        }
        return;
      case 'ui/slashClose':
        this.service?.closeSlash();
        return;
      case 'ui/approvalAnswer':
        if (this.service) {
          void this.service.answerApproval(msg.eventId, msg.outcome).catch((err) =>
            this.output.appendLine(`[panel] 审批应答失败: ${String(err)}`),
          );
        }
        return;
      case 'ui/goalAction':
        if (this.service) void this.service.goalAction(msg.action);
        return;
    }
  }

  private publish(): void {
    const snap = this.snapshot ?? this.conn?.getSnapshot() ?? null;
    if (!snap) return;
    this.state = this.toPanelState(snap);
    this.postState();
  }

  private toPanelState(snap: LiteSnapshot): PanelState {
    const svc = this.service;
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

  private postState(): void {
    this.post({ type: 'host/state', state: this.state });
  }

  private post(message: HostMessage): void {
    // M8：广播给左/右所有存活视图，两侧始终同屏同会话
    for (const view of this.views.values()) {
      void view.webview.postMessage(message);
    }
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
