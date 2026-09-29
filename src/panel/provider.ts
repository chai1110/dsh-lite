// src/panel/provider.ts — webview 视图宿主（侧栏 + 整页共用）。
//
// iframe 架构（v0.1.0）：webview 只承载一个全幅 iframe（Lite 本地代理地址），
// 官方页面经代理加载（cookie 注入在代理完成），折叠/模型选择/编辑重发全部是官方页面自带能力。
// 扩展侧只负责：起服务（connection）→ 起代理 → 通过 setDisplay 驱动三态（loading/error/ready）。
import * as vscode from 'vscode';

import type { ConnectionManager } from '../connection';
import type { Logger } from '../log';

import { errorPage, loadingPage, readyPage, type PageCtx } from './html';

/** 面板展示状态（由 extension 侧根据 connection + 代理状态合成后驱动） */
export type PanelDisplay =
  | { kind: 'loading'; title: string; hint: string }
  | { kind: 'error'; title: string; detail: string }
  | { kind: 'ready'; url: string };

export class DshLitePanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'dshLite.view.left';
  static readonly viewIdSecondary = 'dshLite.view.right';

  private readonly views = new Map<string, vscode.Webview>();
  private display: PanelDisplay = {
    kind: 'loading',
    title: '正在启动 DSH…',
    hint: '首次启动需要数秒。',
  };
  /** 重试回调（loading/error 页的「重试」按钮触发；extension 注入 conn.reconnect） */
  private refreshHandler: (() => void) | null = null;
  private readonly log: Logger;

  constructor(
    _extensionUri: vscode.Uri,
    log: Logger,
  ) {
    this.log = log;
  }

  /** 连接接线（extension 调用一次）：连接状态变化 → 驱动面板三态；注入重试回调 */
  attachConnection(conn: ConnectionManager, refreshHandler: () => void): void {
    this.refreshHandler = refreshHandler;
    conn.onChange((snap) => this.onConnectionChange(snap));
  }

  /** 连接状态 → 面板三态 */
  private onConnectionChange(snap: LiteSnapshotForProvider): void {
    switch (snap.phase) {
      case 'connecting':
        this.setDisplay({ kind: 'loading', title: '正在启动 DSH…', hint: '首次启动需要数秒。' });
        return;
      case 'ready':
        // ready 页地址由 extension 在代理就绪后通过 setDisplay 下发；此处保持 loading 兜底
        return;
      case 'error':
        this.setDisplay({
          kind: 'error',
          title: 'DSH Lite 启动失败',
          detail: this.errText(snap.errorCode),
        });
        return;
      case 'idle':
        this.setDisplay({ kind: 'loading', title: 'DSH 已停止', hint: '点击重试启动。' });
        return;
      case 'offline':
        this.setDisplay({ kind: 'error', title: '连接断开', detail: '点击重试可重新拉起服务。' });
        return;
    }
  }

  private errText(code: string | null): string {
    const map: Record<string, string> = {
      'err.dshNotFound': '未找到 dsh，请安装 DeepSeek Harness 或在设置里填写路径',
      'err.nodeNotFound': '未找到 Node.js（请检查 PATH）',
      'err.spawnEinval': '启动参数无效，请重试',
      'err.portOccupied': '端口全部被占用，请释放后重试',
      'err.startTimeout': 'dsh 启动超时，请重试',
      'err.startCrashed': 'dsh 启动后崩溃，请查看日志',
      'err.tokenParse': '未取得启动令牌，请重试',
      'err.cookieExchange': '认证交换失败，请重试',
    };
    return (code && map[code]) || '连接出现问题，请重试';
  }

  /** 扩展侧驱动面板显示（状态变化时调用；内部自动刷新所有存活视图） */
  setDisplay(display: PanelDisplay): void {
    this.display = display;
    for (const v of this.views.values()) this.renderInto(v);
    if (this.fullPanel) this.renderInto(this.fullPanel.webview);
  }

  // ===== webview 生命周期 =====

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    const viewType = webviewView.viewType;
    this.views.set(viewType, webviewView.webview);
    webviewView.onDidDispose(() => this.views.delete(viewType));
    this.wireWebview(webviewView.webview);
    this.renderInto(webviewView.webview);
    this.log(`[panel:${viewType}] webview 已创建`);
  }

  /** 在指定 webview 上重渲染当前状态 */
  private renderInto(webview: vscode.Webview): void {
    const ctx: PageCtx = {
      nonce: randomNonce(),
      frameSrc: this.display.kind === 'ready' ? this.display.url : null,
    };
    if (this.display.kind === 'ready') {
      webview.html = readyPage(ctx);
      return;
    }
    if (this.display.kind === 'error') {
      webview.html = errorPage(ctx, this.display.title, this.display.detail);
      return;
    }
    webview.html = loadingPage(ctx, this.display.title, this.display.hint);
  }

  private wireWebview(webview: vscode.Webview): void {
    webview.options = { enableScripts: true };
    webview.onDidReceiveMessage((msg: { type?: string }) => {
      // iframe 架构下页面自身完成一切交互；此处仅保留刷新入口（loading/error 页的重试按钮）
      if (msg?.type === 'ui/refresh') this.refreshHandler?.();
    });
  }

  private renderAll(): void {
    for (const v of this.views.values()) this.renderInto(v);
  }

  /** 供命令层/配置变更触发的整体刷新 */
  refreshAll(): void {
    this.renderAll();
  }

  // ===== 整页模式（编辑区标签；M 系列遗留入口，保留） =====

  private fullPanel: vscode.WebviewPanel | undefined;

  /** 整页打开（编辑区标签）；重复调用只 reveal 已有面板 */
  openFullPage(): void {
    if (this.fullPanel) {
      this.fullPanel.reveal();
      this.renderInto(this.fullPanel.webview);
      return;
    }
    this.fullPanel = vscode.window.createWebviewPanel(
      'dshLite.full',
      'DSH Lite',
      vscode.ViewColumn.Active,
      { enableScripts: true },
    );
    this.fullPanel.onDidDispose(() => (this.fullPanel = undefined));
    this.renderInto(this.fullPanel.webview);
  }
}

/** provider 的轻量类型引用（避免 import 循环） */
interface LiteSnapshotForProvider {
  phase: string;
  errorCode: string | null;
}

function randomNonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
