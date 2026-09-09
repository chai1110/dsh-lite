// src/extension.ts — 扩展入口（纯装配）。
//
// 这里只做：
//   1. 申请 OutputChannel、构造 Logger；
//   2. 一次性迁移（旧视图位置污染）；
//   3. 装配 ConnectionManager + SessionService（带 dispose）；
//   4. 构造 DshLitePanelProvider 并 attach 服务；
//   5. 注册两个 webview viewId（左右栏）；
//   6. 注册面板命令（开左/开右/整页）。
// 业务实现都在 src/{connection,session,panel}/* 里。
import * as vscode from 'vscode';

import { ConnectionManager } from './connection';
import { getConfig } from './config';
import { createLogger } from './log';
import {
  DshLitePanelProvider,
  openChatRight,
  registerPanelCommands,
  runViewLocationMigration,
} from './panel';
import { SessionService } from './session/service';

/** 会话 cwd 过滤根：多根工作区用 dshLite.workspaceRootIndex 选第几个根 */
function pickWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  const idx = Math.min(getConfig().workspaceRootIndex, folders.length - 1);
  return folders[Math.max(0, idx)].uri.fsPath;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // 1. 日志
  const output = vscode.window.createOutputChannel('DSH Lite');
  context.subscriptions.push(output);
  const log = createLogger(output, '[DSH Lite]');
  log('扩展已激活');

  // 2. 一次性迁移（旧 view/container ID 留下的位置污染）
  await runViewLocationMigration(context, log);

  // 3. provider（先构造，注册 view 时由 VS Code 触发 resolveWebviewView）
  const provider = new DshLitePanelProvider(context.extensionUri, log);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DshLitePanelProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(DshLitePanelProvider.viewIdSecondary, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // 4. 连接 + 会话服务装配
  const root = pickWorkspaceRoot();
  const cfg = getConfig();
  const connLog = log.child('conn');
  const conn = new ConnectionManager(
    {
      host: '127.0.0.1',
      port: cfg.advanced.port,
      cwd: root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      executablePath: cfg.executablePath || undefined,
      autoStart: cfg.autoStart,
      workspaceRoot: root,
    },
    { log: (line) => connLog(line) },
  );
  context.subscriptions.push({ dispose: () => conn.dispose() });

  const service = new SessionService(conn, {
    log: (line) => log.child('session')(line),
    workspaceRoot: root,
    followUpMode: cfg.followUpQueueMode,
  });
  provider.attachConnection(conn, service);

  // 5. 开机即右侧
  if (cfg.openOnStartup) {
    void openChatRight();
  }

  // 6. 命令注册（开左/开右/整页）
  registerPanelCommands(context, provider);
}

export async function deactivate(): Promise<void> {
  // 子进程与 WS 清理由 connection dispose / 父进程退出钩子兜底
}
