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
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DshLitePanelProvider.viewId, provider, {
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

  if (cfg.openOnStartup) {
    void vscode.commands.executeCommand(`${DshLitePanelProvider.viewId}.focus`);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('dshLite.openSidebar', async () => {
      await vscode.commands.executeCommand(`${DshLitePanelProvider.viewId}.focus`);
    }),
  );
}

export async function deactivate(): Promise<void> {
  // 子进程与 WS 清理由 connection dispose / 父进程退出钩子兜底
}
