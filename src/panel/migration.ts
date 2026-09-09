// src/panel/migration.ts — 一次性版本迁移。
//
// 历史包袱：M8~M12 对「未展开的右侧视图」直接 .focus() 时，VS Code 把视图挪进了当时可见的
// 左侧 Explorer 并把位置持久化到 workspaceStorage（explorer.views.state）。
// M13.1 改了 view/container id（dshLitePanel / dshLitePanelRight）但旧记录仍在。
// 这里在激活时探测旧命令是否存在，存在则执行一次精准迁移（失败回退全局 reset）。
import * as vscode from 'vscode';

import type { Logger } from '../log';

const MIGRATION_KEY = 'dshLite.viewLocationMigrated_v2';

interface OldProbe {
  hasOldLeft: boolean;
  hasOldRight: boolean;
  hasOldContainer: boolean;
  hasMoveView: boolean;
}

async function probe(): Promise<OldProbe> {
  const cmds = await vscode.commands.getCommands(true);
  return {
    hasOldLeft: cmds.includes('dshLite.panel.focus'),
    hasOldRight: cmds.includes('dshLite.panel.secondary.focus'),
    hasOldContainer: cmds.includes('workbench.view.extension.dshLite'),
    hasMoveView: cmds.includes('workbench.action.moveView'),
  };
}

/** 触发条件：探测到任何旧 view/container 命令仍未注销。 */
export function needsMigration(probe: OldProbe): boolean {
  return probe.hasOldLeft || probe.hasOldRight || probe.hasOldContainer;
}

/**
 * 一次性迁移：仅在 globalState 标记未置位时执行。优先 moveView 精准迁移到新容器，
 * moveView 不可用或单步失败时回退到 workbench.action.resetViewLocations。
 */
export async function runViewLocationMigration(
  context: vscode.ExtensionContext,
  log: Logger,
): Promise<void> {
  if (context.globalState.get(MIGRATION_KEY)) return;

  const p = await probe();
  if (needsMigration(p)) {
    log('检测到旧版本视图位置残留，正在执行一次性迁移…');
    if (p.hasMoveView) {
      if (p.hasOldRight) {
        try {
          await vscode.commands.executeCommand('workbench.action.moveView', {
            viewId: 'dshLite.panel.secondary',
            containerId: 'dshLitePanelRight',
          });
          log('已将旧 dshLite.panel.secondary 迁移到 dshLitePanelRight');
        } catch (err) {
          log(`迁移旧右视图失败: ${String(err)}`);
        }
      }
      if (p.hasOldLeft) {
        try {
          await vscode.commands.executeCommand('workbench.action.moveView', {
            viewId: 'dshLite.panel',
            containerId: 'dshLitePanel',
          });
          log('已将旧 dshLite.panel 迁移到 dshLitePanel');
        } catch (err) {
          log(`迁移旧左视图失败: ${String(err)}`);
        }
      }
    } else {
      try {
        await vscode.commands.executeCommand('workbench.action.resetViewLocations');
        log('已执行 workbench.action.resetViewLocations');
      } catch (err) {
        log(`resetViewLocations 失败: ${String(err)}`);
      }
    }
  }
  await context.globalState.update(MIGRATION_KEY, true);
}
