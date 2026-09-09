// src/panel/migration.ts — 一次性视图位置清理。
//
// 背景：M8 ~ M12 的 manifest 把 view/container id 定为 dshLite / dshLiteSecondary /
// dshLite.panel / dshLite.panel.secondary。那时一旦在未展开的右侧视图上 .focus()，
// VS Code 会把它挪进当时可见的左侧 Explorer 并把位置持久化进 workspaceStorage。
// M13.1 改了 view/container id（dshLitePanel + dshLitePanelRight + dshLite.view.left/right），
// 但旧 viewId 在 explorer.views.state 里仍是孤儿子键，VS Code 按 Explorer 子视图渲染，
// 表现就是「资源管理器里多出一个 DSH 」。
//
// 修复策略：直读 sqlite3 精准删 stale viewId 子键 + 死 container state。
// 副作用最小，不动其它视图布局，也不靠「旧命令是否注册」做条件。
//
// 幂等性：每个 key 子项用 hasOwnProperty 判断，删过就没了。globalState flag 兜底只跑一次。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';

import type { Logger } from '../log';

const MIGRATION_KEY = 'dshLite.viewLocationMigrated_v4';

// M13.1 之前用过的 view id；manifest 已删，但 workspaceStorage 里仍有 stale 记录。
// M13.1 之后的新 view id（dshLite.view.left/right）也可能被用户/VS Code 拖进 Explorer 容器，
// 出现在 explorer.views.state 里 —— 这两个 view 的归属位置应该是 activitybar / secondarySidebar
// 容器（见 package.json views.dshLitePanel / views.dshLitePanelRight），
// 在 Explorer 容器里出现 = 位置错乱，必须清掉。
const ORPHAN_VIEW_IDS_IN_EXPLORER = [
  'dshLite.panel',
  'dshLite.panel.secondary',
  'dshLite.view.left',
  'dshLite.view.right',
];
const LEGACY_CONTAINER_STATE_KEYS = [
  'workbench.view.extension.dshLite.state',
  'workbench.view.extension.dshLiteSecondary.state',
];
const EXPLORER_KEY = 'workbench.explorer.views.state';

interface SqlitePathInfo {
  /** 平台对应的 workspaceStorage 根 */
  storageRoot: string | null;
  /** sqlite3 CLI 路径；找不到为 null */
  sqliteBin: string | null;
}

function platformStorageRoot(): string | null {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library/Application Support/Code/User/workspaceStorage');
    case 'win32': {
      const appData = process.env.APPDATA ?? path.join(home, 'AppData/Roaming');
      return path.join(appData, 'Code/User/workspaceStorage');
    }
    default:
      return path.join(home, '.config/Code/User/workspaceStorage');
  }
}

function locateSqlite(): string | null {
  // 何处找 sqlite3：PATH → macOS 常见位置 + Homebrew。
  const candidates = process.platform === 'darwin'
    ? ['/opt/homebrew/bin/sqlite3', '/usr/bin/sqlite3', '/opt/miniconda3/bin/sqlite3']
    : ['/usr/bin/sqlite3'];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  const probe = spawnSync('which', ['sqlite3'], { encoding: 'utf8' });
  const found = probe.stdout?.trim();
  return found ? found : null;
}

/** 读 ItemTable 中某 key 的 value，原文返回（不含末尾换行）。 */
function readValue(sqliteBin: string, dbPath: string, key: string): string | null {
  const sql = `SELECT value FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}';\n`;
  const res = spawnSync(sqliteBin, [`file:${dbPath}?mode=ro`], {
    input: sql,
    encoding: 'utf8',
    timeout: 3000,
  });
  if (res.status !== 0) return null;
  const out = res.stdout.trim();
  return out ? out : null;
}

/** 拷贝 db → 改/删行 → 覆盖回原处。出错时尽量清理 tmp。 */
function mutateDb(sqliteBin: string, dbPath: string, mutate: (conn: SqliteConn) => void): { ok: boolean; changed: boolean; err?: string } {
  const tmp = path.join(os.tmpdir(), `dsh-lite-purge-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.vscdb`);
  try {
    fs.copyFileSync(dbPath, tmp);
    const conn: SqliteConn = {
      read(key: string): string | null { return readValue(sqliteBin, tmp, key); },
      update(key: string, value: string): boolean {
        const sql = `UPDATE ItemTable SET value = '${value.replace(/'/g, "''")}' WHERE key = '${key.replace(/'/g, "''")}';\n`;
        const res = spawnSync(sqliteBin, [tmp], { input: sql, encoding: 'utf8', timeout: 3000 });
        return res.status === 0;
      },
      delete(key: string): boolean {
        const sql = `DELETE FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}';\n`;
        const res = spawnSync(sqliteBin, [tmp], { input: sql, encoding: 'utf8', timeout: 3000 });
        return res.status === 0;
      },
    };
    const before = {
      exp: readValue(sqliteBin, tmp, EXPLORER_KEY),
      ks: LEGACY_CONTAINER_STATE_KEYS.map((k) => [k, readValue(sqliteBin, tmp, k)] as const),
    };
    mutate(conn);
    // 检测是否真的改了东西
    const afterExp = readValue(sqliteBin, tmp, EXPLORER_KEY);
    const afterKs = LEGACY_CONTAINER_STATE_KEYS.map((k) => readValue(sqliteBin, tmp, k));
    const explorerChanged = before.exp !== afterExp;
    const keysChanged = before.ks.some(([, v], i) => v !== afterKs[i]);
    if (!explorerChanged && !keysChanged) return { ok: true, changed: false };
    fs.copyFileSync(tmp, dbPath);
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, err: String(err) };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

interface SqliteConn {
  read(key: string): string | null;
  update(key: string, value: string): boolean;
  delete(key: string): boolean;
}

/** 单个 db 上：解析 explorer.views.state，删 ORPHAN_VIEW_IDS_IN_EXPLORER 子键；删 LEGACY_CONTAINER_STATE_KEYS 整行。 */
function purgeLegacyInDb(sqliteBin: string, dbPath: string, log: Logger): { touched: boolean; details: string[] } {
  const details: string[] = [];
  const result = mutateDb(sqliteBin, dbPath, (conn) => {
    // 1) explorer.views.state JSON 内子键
    const raw = conn.read(EXPLORER_KEY);
    if (!raw) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      log(`  explorer.views.state JSON 解析失败，跳过: ${String(err)}`);
      return;
    }
    let removed: string[] = [];
    for (const id of ORPHAN_VIEW_IDS_IN_EXPLORER) {
      if (Object.prototype.hasOwnProperty.call(obj, id)) {
        delete obj[id];
        removed.push(id);
      }
    }
    if (removed.length > 0) {
      const ok = conn.update(EXPLORER_KEY, JSON.stringify(obj));
      details.push(`explorer.views.state 移除 ${removed.join(', ')}${ok ? '' : '（写回失败）'}`);
    }

    // 2) 死 container 的 instance state
    for (const k of LEGACY_CONTAINER_STATE_KEYS) {
      if (conn.read(k) !== null) {
        const ok = conn.delete(k);
        if (ok) details.push(`删除 key ${k}`);
      }
    }
  });
  if (!result.ok) {
    log(`  ${path.basename(path.dirname(dbPath))}: 失败 ${result.err}`);
    return { touched: false, details };
  }
  if (result.changed && details.length > 0) {
    log(`  ${path.basename(path.dirname(dbPath))}:`);
    for (const d of details) log(`    - ${d}`);
    return { touched: true, details };
  }
  return { touched: false, details };
}

export function needsMigration(_ctx: vscode.ExtensionContext): boolean {
  // 新版探测：判 v3 flag 是否置位。
  // 保留函数签名供兼容；实际 runViewLocationMigration 内部已经 gate。
  return false;
}

/**
 * 一次性迁移：从所有 workspaceStorage/<hash>/state.vscdb 里清除 M13.1 之前的视图位置残留。
 * 仅在 globalState flag 未置位时执行；执行后将 flag 置位。
 */
export async function runViewLocationMigration(
  context: vscode.ExtensionContext,
  log: Logger,
): Promise<void> {
  if (context.globalState.get(MIGRATION_KEY)) return;

  const info: SqlitePathInfo = {
    storageRoot: platformStorageRoot(),
    sqliteBin: locateSqlite(),
  };

  if (!info.storageRoot || !fs.existsSync(info.storageRoot)) {
    log(`跳过视图位置清理：找不到 ${info.storageRoot ?? '<storageRoot>'}`);
    await context.globalState.update(MIGRATION_KEY, true);
    return;
  }
  if (!info.sqliteBin) {
    log('跳过视图位置清理：未找到 sqlite3 CLI');
    await context.globalState.update(MIGRATION_KEY, true);
    return;
  }

  log('清理 M13.1 之前的视图位置残留…');

  let touched = 0;
  let scanned = 0;
  for (const wsHash of fs.readdirSync(info.storageRoot)) {
    const db = path.join(info.storageRoot, wsHash, 'state.vscdb');
    if (!fs.existsSync(db)) continue;
    scanned++;
    const { touched: t } = purgeLegacyInDb(info.sqliteBin, db, log);
    if (t) touched++;
  }

  log(`视图位置清理完成：扫描 ${scanned} 个工作区，改动 ${touched} 个`);
  await context.globalState.update(MIGRATION_KEY, true);
}
