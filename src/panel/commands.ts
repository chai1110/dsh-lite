// src/panel/commands.ts — 注册面板相关命令。
//
// 包含：openSidebar（左侧）/ openChat（右侧两步法）/ openChatFull（整页）。
// 抽出原则：命令注册的副作用（registerCommand / executeCommand）集中在入口；UI/逻辑保持
// 在 provider / session-service，命令只是一个壳。
import * as vscode from 'vscode';

import { DshLitePanelProvider } from './provider';

/**
 * 把 ② 侧栏 / ③ 右上角 / ④ 整页 三个入口的命令注册到 context.subscriptions。
 * 由 extension.ts 的 activate() 阶段调用。
 */
export function registerPanelCommands(
  context: vscode.ExtensionContext,
  provider: DshLitePanelProvider,
): void {
  // 左活动栏图标 / 命令面板「打开 DSH 侧栏（左侧）」
  context.subscriptions.push(
    vscode.commands.registerCommand('dshLite.openSidebar', async () => {
      try {
        await vscode.commands.executeCommand(`workbench.view.extension.dshLitePanel`);
        await vscode.commands.executeCommand(`${DshLitePanelProvider.viewId}.focus`);
      } catch {
        // 兜底：即便容器命令不可用也尝试直接聚焦视图
        await vscode.commands.executeCommand(`${DshLitePanelProvider.viewId}.focus`);
      }
    }),
  );

  // 右上角 editor/title 入口 → 共享 openChatRight（开机即右侧也用）
  context.subscriptions.push(
    vscode.commands.registerCommand('dshLite.openChat', openChatRight),
  );

  // 整页（编辑区标签）入口
  context.subscriptions.push(
    vscode.commands.registerCommand('dshLite.openChatFull', () => provider.openFullPage()),
  );
}

/**
 * Code0x/CC 两步聚焦法：先展开右侧 secondarySidebar 容器，再 focus 内部 view。
 * <1.106（无 secondarySidebar 容器）时回退到左侧容器；再兜底直接 focus。
 * 给编辑器标题栏命令与 openOnStartup 共用。
 */
export const openChatRight = async (): Promise<void> => {
  try {
    await vscode.commands.executeCommand(`workbench.view.extension.dshLitePanelRight`);
    await vscode.commands.executeCommand(`${DshLitePanelProvider.viewIdSecondary}.focus`);
  } catch {
    try {
      await vscode.commands.executeCommand(`workbench.view.extension.dshLitePanel`);
      await vscode.commands.executeCommand(`${DshLitePanelProvider.viewId}.focus`);
    } catch {
      await vscode.commands.executeCommand(`${DshLitePanelProvider.viewId}.focus`);
    }
  }
};
