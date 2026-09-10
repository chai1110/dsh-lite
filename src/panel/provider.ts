// src/panel/provider.ts — webview 视图宿主（侧栏 + 整页共用的接线和广播层）。
//
// 职责：
//   1. 接收 resolveWebviewView（侧栏）与 openFullPage（整页）注册的 webview 句柄；
//   2. 装载同一份 HTML（抽到 ./html）+ 同一套消息分发（handleUiMessage）；
//   3. 状态变更时把合成好的 PanelState（抽到 ./state）广播给所有存活面；
//   4. hello 应答只回发出方（多面共存时不重复广播）。
//
// 不在这里做：状态合成（state.ts）、HTML 生成（html.ts）、命令注册（commands.ts）、
// 一次性迁移（migration.ts）—— 那些都在独立模块。
import * as vscode from 'vscode';

import type { ConnectionManager, LiteSnapshot } from '../connection';
import type { Logger } from '../log';
import type { SessionService } from '../session/service';

import { getHtml } from './html';
import {
  initialState,
  isProtocolCompatible,
  mismatchHint,
  PROTOCOL_VERSION,
  type HostMessage,
  type PanelState,
  type UiMessage,
} from './protocol';
import { buildPanelState } from './state';

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
  private snapshot: LiteSnapshot | null = null;
  private readonly log: Logger;

  constructor(
    private readonly extensionUri: vscode.Uri,
    log: Logger,
  ) {
    this.log = log;
  }

  /** 在面板首次解析前由扩展入口注入 */
  attachConnection(conn: ConnectionManager, service: SessionService): void {
    this.conn = conn;
    this.service = service;
    conn.onChange((snap) => {
      this.snapshot = snap;
      this.publish();
    });
    service.onChange(() => this.publish());
  }

  // ===== resolveWebviewView / openFullPage =====

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
    this.log(`[panel:${viewType}] webview 已创建，等待 UI 握手`);
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
    this.log('[panel:dshLite.full] 整页对话已打开');
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
    webview.html = getHtml(webview, outUri, assetsUri, full);
    webview.onDidReceiveMessage((raw: unknown) => {
      if (typeof raw !== 'object' || raw === null || typeof (raw as UiMessage).type !== 'string') {
        return;
      }
      this.handleUiMessage(raw as UiMessage, webview);
    });
    attachDispose();
  }

  // ===== UI → 宿主消息分发 =====

  private handleUiMessage(msg: UiMessage, from: vscode.Webview): void {
    switch (msg.type) {
      case 'hello': {
        if (!isProtocolCompatible(msg.protocolVersion)) {
          const hint = mismatchHint(msg.protocolVersion);
          const message =
            hint === 'reload' ? '请重载窗口以更新面板' : '面板版本高于扩展，请更新 DSH Lite';
          this.log(
            `协议版本不匹配：UI=${msg.protocolVersion} 宿主=${PROTOCOL_VERSION} → ${hint}`,
          );
          this.postTo(from, { type: 'host/error', code: 'protocol-mismatch', message });
          return;
        }
        // M13：hello 应答只回给发出方（多面共存时不再向所有 webview 重复广播 hello）
        this.postTo(from, { type: 'hello', protocolVersion: PROTOCOL_VERSION });
        this.log(`[panel] UI 握手完成（protocol=${msg.protocolVersion}），下发初始状态`);
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
        this.log(`切换会话: ${msg.sessionId}`);
        this.service?.select(msg.sessionId);
        return;
      case 'ui/sessionRename':
        if (this.service) {
          void this.service.renameSession(msg.sessionId, msg.title).catch((err) =>
            this.log(`会话改名失败: ${String(err)}`),
          );
        }
        return;
      case 'ui/sessionArchive':
        if (this.service) {
          void this.service.archiveSession(msg.sessionId).catch((err) =>
            this.log(`归档失败: ${String(err)}`),
          );
        }
        return;
      case 'ui/sessionUnarchive':
        if (this.service) {
          void this.service.unarchiveSession(msg.sessionId).catch((err) =>
            this.log(`取消归档失败: ${String(err)}`),
          );
        }
        return;
      case 'ui/newSession':
        if (this.service) {
          void this.service.create().catch((err) => this.log(`新建失败: ${String(err)}`));
        }
        return;
      case 'ui/promptSubmit': {
        if (this.service) {
          void this.service.submit(msg.text).catch((err) =>
            this.log(`发送失败: ${String(err)}`),
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
            this.log(`命令目录拉取失败: ${String(err)}`),
          );
        }
        return;
      case 'ui/slashClose':
        this.service?.closeSlash();
        return;
      case 'ui/approvalAnswer':
        if (this.service) {
          void this.service.answerApproval(msg.eventId, msg.outcome).catch((err) =>
            this.log(`审批应答失败: ${String(err)}`),
          );
        }
        return;
      case 'ui/goalAction':
        if (this.service) void this.service.goalAction(msg.action);
        return;
    }
  }

  /** 配置变更后重发状态（如 composerEnterBehavior 影响输入框提示语，需立即下发） */
  republish(): void {
    this.publish();
  }

  // ===== 宿主 → UI 状态发布 =====

  private publish(): void {
    const next = buildPanelState({
      snapshot: this.snapshot,
      conn: this.conn ?? null,
      service: this.service ?? null,
    });
    this.state = next;
    this.post({ type: 'host/state', state: this.state });
  }

  /** 广播给所有存活面（侧栏视图 + 整页面板），三面同屏同会话 */
  private post(message: HostMessage): void {
    for (const view of this.views.values()) {
      void view.webview.postMessage(message);
    }
    if (this.fullPanel) {
      void this.fullPanel.webview.postMessage(message);
    }
  }

  /** 定向投递（hello 应答专用，避免对其它面重复广播） */
  private postTo(webview: vscode.Webview, message: HostMessage): void {
    void webview.postMessage(message);
  }
}
