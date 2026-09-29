// src/extension.ts — 扩展入口（iframe 架构装配）。
//
// 职责：
//   1. 日志 + 一次性迁移（旧视图位置）；
//   2. ConnectionManager（起服务 + 令牌换 cookie）；
//   3. Lite 本地代理（cookie 注入 + 隐藏设置入口 + WS 转发）；
//   4. 面板 provider（iframe 加载代理地址，三态驱动）；
//   5. 视图注册 + 面板命令。
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
import { createLiteProxy } from './service/proxy';

/** 会话 cwd：多根工作区用 dshLite.workspaceRootIndex 选第几个根 */
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
  log('扩展已激活（iframe 官方页面架构）');

  // 2. 一次性迁移（旧 view/container ID 留下的位置污染）
  try {
    await runViewLocationMigration(context, log);
  } catch (err) {
    log(`视图位置迁移失败（已忽略，不影响扩展功能）: ${String(err)}`);
  }

  // 3. 连接管理（进程 + 令牌 + cookie）
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
    },
    { log: (line) => connLog(line) },
  );
  context.subscriptions.push({ dispose: () => void conn.stop() });

  // 4. Lite 本地代理（cookie 注入 + 隐藏设置入口 + WS 转发）
  const proxy = createLiteProxy({
    getTarget: () => {
      const snap = conn.getSnapshot();
      if (snap.phase !== 'ready' || !snap.origin || !snap.cookie) return null;
      return { url: snap.origin, cookie: snap.cookie };
    },
    log: (line) => log.child('proxy')(line),
  });
  await proxy.start();
  context.subscriptions.push({ dispose: () => void proxy.stop() });
  log(`[proxy] 本地代办就绪 ${proxy.baseUrl}`);

  // 5. 面板 provider（三态由 conn.onChange 驱动）
  const provider = new DshLitePanelProvider(context.extensionUri, log);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DshLitePanelProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(DshLitePanelProvider.viewIdSecondary, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  provider.attachConnection(conn, () => void conn.reconnect());

  // 6. 开机即右侧
  if (cfg.openOnStartup) {
    void openChatRight();
  }

  // 7. 命令注册
  registerPanelCommands(context, provider);

  // 8. 配置变更：连接相关键需重载窗口
  const AFFECTS_CONNECTION = [
    'dshLite.executablePath',
    'dshLite.autoStart',
    'dshLite.advanced.port',
    'dshLite.workspaceRootIndex',
  ];
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (AFFECTS_CONNECTION.some((k) => e.affectsConfiguration(k))) {
        void vscode.window
          .showInformationMessage('DSH Lite：连接相关设置已更改，需重载窗口后生效。', '重载窗口')
          .then((pick) => {
            if (pick === '重载窗口') void vscode.commands.executeCommand('workbench.action.reloadWindow');
          });
        return;
      }
      provider.refreshAll();
    }),
  );
}

export async function deactivate(): Promise<void> {
  // 子进程清理由 connection dispose / 父进程退出钩子兜底
}
