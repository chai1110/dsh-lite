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
  // M13.1：view/container ID 换新（dshLite.panel[.secondary]/dshLiteSecondary 作废）。
  // 根因：M8~M12 对「未展开的右侧视图」直接 .focus()，VS Code 找不到其容器时把视图挪进
  // 当时可见的左侧 Explorer 并把位置写进了 workspaceStorage（explorer.views.state），此后无论
  // 命令怎么改，视图都按记忆渲染在 Explorer 里。换全新 ID = 抹掉这份陈旧位置，回归声明位置注册。
  static readonly viewId = 'dshLite.view.left';
  static readonly viewIdSecondary = 'dshLite.view.right';

  /** 当前存活的 webview 视图，按 viewType(=viewId) 索引：左侧栏与右侧栏可并存 */
  private readonly views = new Map<string, vscode.WebviewView>();
  /** M13：整页对话（WebviewPanel，以编辑器标签形式占满编辑区）；单实例，重复打开只 reveal */
  private fullPanel?: vscode.WebviewPanel;
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
    this.wireWebview(webviewView.webview, () => {
      // 视图关闭 → 从广播集移除（右侧栏隐藏≠dispose；只有真正关闭才触发）
      webviewView.onDidDispose(() => this.views.delete(viewType));
    });
    this.output.appendLine(`[panel:${viewType}] webview 已创建，等待 UI 握手`);
  }

  /** M13：整页对话 —— 以 WebviewPanel 在编辑区开一个「DSH Lite」标签，占满整页（对齐 Chat Editor 形态）。
   *  与左/右侧栏共用同一 host（provider.post 广播）与同一会话，任何一面操作其它面同步。 */
  openFullPage(): void {
    if (this.fullPanel) {
      this.fullPanel.reveal(vscode.ViewColumn.Active, true);
      return;
    }
    const outUri = vscode.Uri.joinPath(this.extensionUri, 'out');
    const assetsUri = vscode.Uri.joinPath(this.extensionUri, 'assets');
    const panel = vscode.window.createWebviewPanel(
      'dshLite.chat.full',
      'DSH Lite',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [outUri, assetsUri],
      },
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(assetsUri, 'icon-light.svg'),
      dark: vscode.Uri.joinPath(assetsUri, 'icon-dark.svg'),
    };
    this.fullPanel = panel;
    this.wireWebview(panel.webview, () => {
      panel.onDidDispose(() => {
        if (this.fullPanel === panel) this.fullPanel = undefined;
      });
    }, true);
    this.output.appendLine('[panel:dshLite.full] 整页对话已打开');
  }

  /** 给一个 webview（侧栏视图或整页面板）装载同一份 HTML/协议，事件统一进 handleUiMessage */
  private wireWebview(webview: vscode.Webview, attachDispose: () => void, full = false): void {
    const outUri = vscode.Uri.joinPath(this.extensionUri, 'out');
    const assetsUri = vscode.Uri.joinPath(this.extensionUri, 'assets');
    webview.options = {
      enableScripts: true,
      // M9：out/=构建产物（webview bundle+css）；assets/=图标字体（codicon）等静态资源
      localResourceRoots: [outUri, assetsUri],
    };
    webview.html = this.getHtml(webview, outUri, assetsUri, full);
    webview.onDidReceiveMessage((raw: unknown) => {
      if (typeof raw !== 'object' || raw === null || typeof (raw as UiMessage).type !== 'string') {
        return;
      }
      this.handleUiMessage(raw as UiMessage, webview);
    });
    attachDispose();
  }

  private handleUiMessage(msg: UiMessage, from: vscode.Webview): void {
    switch (msg.type) {
      case 'hello': {
        if (!isProtocolCompatible(msg.protocolVersion)) {
          const hint = mismatchHint(msg.protocolVersion);
          const message =
            hint === 'reload' ? '请重载窗口以更新面板' : '面板版本高于扩展，请更新 DSH Lite';
          this.output.appendLine(
            `[panel] 协议版本不匹配：UI=${msg.protocolVersion} 宿主=${PROTOCOL_VERSION} → ${hint}`,
          );
          this.postTo(from, { type: 'host/error', code: 'protocol-mismatch', message });
          return;
        }
        // M13：hello 应答只回给发出方（多面共存时不再向所有 webview 重复广播 hello）
        this.postTo(from, { type: 'hello', protocolVersion: PROTOCOL_VERSION });
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
    // M8：广播给左/右所有存活视图，两侧始终同屏同会话；M13：整页标签也并入广播
    for (const view of this.views.values()) {
      void view.webview.postMessage(message);
    }
    if (this.fullPanel) {
      void this.fullPanel.webview.postMessage(message);
    }
  }

  private postTo(webview: vscode.Webview, message: HostMessage): void {
    void webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview, outUri: vscode.Uri, assetsUri: vscode.Uri, full = false): string {
    const nonce = randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(outUri, 'webview.js'));

    const cssUri = vscode.Uri.joinPath(outUri, 'webview.css');
    const cssLink = existsSync(cssUri.fsPath)
      ? `<link rel="stylesheet" href="${webview.asWebviewUri(cssUri)}" />`
      : '';

    // M9：codicon 图标字体（assets/codicons/ 已在仓库内，缺失时优雅降级为纯文本 UI）
    const codiconUri = vscode.Uri.joinPath(assetsUri, 'codicons', 'codicon.css');
    const codiconLink = existsSync(codiconUri.fsPath)
      ? `<link rel="stylesheet" href="${webview.asWebviewUri(codiconUri)}" />`
      : '';

    // M9b：品牌 logo（assets/icon.svg）以全局变量下发，供顶栏显示；缺失时为空串（UI 不显示 logo）
    const logoUri = vscode.Uri.joinPath(assetsUri, 'icon.svg');
    const logoUrl = existsSync(logoUri.fsPath) ? webview.asWebviewUri(logoUri).toString() : '';

    const csp = [
      "default-src 'none'",
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`, // M9：codicon 图标字体
      `img-src ${webview.cspSource} data:`,
    ].join('; ');

    // M13：整页模式把内容约束为居中阅读列（避免全宽拉伸），背景切编辑器底色，左右加细分隔
    const fullCss = full
      ? `<style>
      body.dsh-full {
        background-color: var(--vscode-editor-background, var(--vscode-sideBar-background));
      }
      body.dsh-full .app {
        max-width: 1160px;
        width: 100%;
        margin: 0 auto;
        border-left: 1px solid var(--vscode-panel-border, transparent);
        border-right: 1px solid var(--vscode-panel-border, transparent);
      }
    </style>`
      : '';

    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DSH Lite</title>
    ${codiconLink}
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
    ${fullCss}
  </head>
  <body${full ? ' class="dsh-full"' : ''}>
    <div id="root"></div>
    <script nonce="${nonce}">window.DSH_LOGO=${JSON.stringify(logoUrl)};</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
