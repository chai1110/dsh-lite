// src/extension.ts — 扩展入口：装配输出通道、侧栏 provider 与唯一一条命令。
// M0 阶段这里不做任何 DSH 连接（那是 M1）。
import * as vscode from 'vscode';

import { DshLitePanelProvider } from './panel/provider';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('DSH Lite');
  context.subscriptions.push(output);
  output.appendLine('[DSH Lite] 扩展已激活（M0 骨架，未连接 DSH）');

  const provider = new DshLitePanelProvider(context.extensionUri, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DshLitePanelProvider.viewId, provider, {
      // 侧栏被折叠/切走时保留 UI 状态，避免每次回来都重新握手。
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dshLite.openSidebar', async () => {
      // VS Code 为每个 view 自动提供 `<viewId>.focus` 内置命令。
      await vscode.commands.executeCommand(`${DshLitePanelProvider.viewId}.focus`);
    }),
  );
}

export function deactivate(): void {
  // M0 没有子进程与长连接，输出通道/命令/provider 都挂在 context.subscriptions 上由宿主释放。
  // M1 会在此 dispose dsh 进程监听与事件流连接。
}
