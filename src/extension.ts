// src/extension.ts — 扩展入口：装配输出通道、连接管理器与侧栏 provider。
// M1：面板打开时自动拉起 dsh 并连上 remote.mux；命令仅保留 openSidebar（M3+ 再补命令）。
import * as vscode from 'vscode';

import { ConnectionManager } from './connection';
import { getConfig } from './config';
import { DshLitePanelProvider } from './panel/provider';

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
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DshLitePanelProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // 连接管理器：日志走 OutputChannel；参数从配置读取（文档：docs/api/connection.md §7）
  const conn = new ConnectionManager(
    {
      host: '127.0.0.1',
      port: getConfig().advanced.port,
      cwd: pickWorkspaceRoot() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      executablePath: getConfig().executablePath || undefined,
      autoStart: getConfig().autoStart,
      workspaceRoot: pickWorkspaceRoot(),
    },
    { log: (line) => output.appendLine(line) },
  );
  context.subscriptions.push({ dispose: () => conn.dispose() });

  // openOnStartup：激活后自动聚焦侧栏（聚焦会触发 resolve → 连接）
  if (getConfig().openOnStartup) {
    void vscode.commands.executeCommand(`${DshLitePanelProvider.viewId}.focus`);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('dshLite.openSidebar', async () => {
      await vscode.commands.executeCommand(`${DshLitePanelProvider.viewId}.focus`);
    }),
  );
}

export async function deactivate(): Promise<void> {
  // 子进程与 WS 的停止由扩展退出前的清理钩子兜底；此处显式停止一次（幂等）。
}
