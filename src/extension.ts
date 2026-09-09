// src/extension.ts — 扩展入口：装配输出通道、连接管理器、会话服务与侧栏 provider。
import * as vscode from 'vscode';

import { ConnectionManager } from './connection';
import { getConfig } from './config';
import { DshLitePanelProvider } from './panel/provider';
import { SessionService } from './session/service';

/** 会话 cwd 过滤根：多根工作区用 dshLite.workspaceRootIndex 选第几个根 */
function pickWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  const idx = Math.min(getConfig().workspaceRootIndex, folders.length - 1);
  return folders[Math.max(0, idx)].uri.fsPath;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('DSH Lite');
  context.subscriptions.push(output);
  output.appendLine('[DSH Lite] 扩展已激活');

  const provider = new DshLitePanelProvider(context.extensionUri, output);
  // M8：同一 provider 实例同时服务左侧栏(dshLite.panel)与右侧栏(dshLite.panel.secondary)两个视图，
  // 各自独立 resolve，宿主状态广播到两侧，保证左右同屏同会话（与 Codex / Claude Code 一致）。
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DshLitePanelProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(DshLitePanelProvider.viewIdSecondary, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const root = pickWorkspaceRoot();
  const cfg = getConfig();
  const conn = new ConnectionManager(
    {
      host: '127.0.0.1',
      port: cfg.advanced.port,
      cwd: root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      executablePath: cfg.executablePath || undefined,
      autoStart: cfg.autoStart,
      workspaceRoot: root,
    },
    { log: (line) => output.appendLine(line) },
  );
  context.subscriptions.push({ dispose: () => conn.dispose() });

  const service = new SessionService(conn, {
    log: (line) => output.appendLine(line),
    workspaceRoot: root,
    followUpMode: cfg.followUpQueueMode,
  });

  provider.attachConnection(conn, service);

  // M12：对齐 Codex/CC 的「两步聚焦法」——先显式展开容器，再 focus 内部 view。
  // 证据：Codex openSidebar = executeCommand(`workbench.view.extension.codexSecondaryViewContainer`)
  //   + executeCommand(`chatgpt.sidebarSecondaryView.focus`)；CC sidebar.open = focus + show()。
  // 仅 .focus() 无法把默认隐藏的 secondarySidebar 容器拉开 → 之前点击右上角会跑到左侧/无反应。
  // M13：抽成共享函数，openChat 命令与 openOnStartup（开机即右侧）共用。
  const openChatRight = async (): Promise<void> => {
    try {
      await vscode.commands.executeCommand(`workbench.view.extension.dshLiteSecondary`);
      await vscode.commands.executeCommand(`${DshLitePanelProvider.viewIdSecondary}.focus`);
    } catch {
      try {
        await vscode.commands.executeCommand(`workbench.view.extension.dshLite`);
        await vscode.commands.executeCommand(`${DshLitePanelProvider.viewId}.focus`);
      } catch {
        await vscode.commands.executeCommand(`${DshLitePanelProvider.viewId}.focus`);
      }
    }
  };

  if (cfg.openOnStartup) {
    void openChatRight();
  }

  context.subscriptions.push(
    // M12：对齐 Codex/CC 的「两步聚焦法」——先显式展开容器，再 focus 内部 view。
    // 证据：Codex openSidebar = executeCommand(`workbench.view.extension.codexSecondaryViewContainer`)
    //   + executeCommand(`chatgpt.sidebarSecondaryView.focus`)；CC sidebar.open = focus + show()。
    // 仅 .focus() 无法把默认隐藏的 secondarySidebar 容器拉开 → 之前点击右上角会跑到左侧/无反应。
    vscode.commands.registerCommand('dshLite.openSidebar', async () => {
      try {
        await vscode.commands.executeCommand(`workbench.view.extension.dshLite`);
        await vscode.commands.executeCommand(`${DshLitePanelProvider.viewId}.focus`);
      } catch {
        // 兜底：即便容器命令不可用也尝试直接聚焦视图
        await vscode.commands.executeCommand(`${DshLitePanelProvider.viewId}.focus`);
      }
    }),
    // M8：右上角 editor/title 入口 → 在右侧（次要）侧栏展开对话；
    // M12 修复：先展开右侧容器 dshLiteSecondary（= 整个右边出现 DSH Lite 栏），再 focus 其 view。
    // 旧版 VS Code(<1.106) 无 secondarySidebar 容器时回退到左侧栏（同样先展开容器）。
    vscode.commands.registerCommand('dshLite.openChat', openChatRight),
    // M13：整页对话 —— 在编辑区以编辑器标签形式开「整页 DSH Lite」（对齐 Chat Editor 形态）；
    // 与左/右侧栏共用同一会话：任一面操作，其它面（含本整页）广播同步。
    vscode.commands.registerCommand('dshLite.openChatFull', () => provider.openFullPage()),
  );
}

export async function deactivate(): Promise<void> {
  // 子进程与 WS 清理由 connection dispose / 父进程退出钩子兜底
}
