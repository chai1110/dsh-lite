// webview/lib/util.ts — 纯函数工具（无 React 依赖，方便单测）。
import type { ViewMessage } from '../../src/panel/protocol';

/** 文本复制（hover 行操作用，失败静默） */
export function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/** M9：按 updatedAt 分桶（对齐 Codex/CC 历史面板的时间分组语） */
export function timeBucket(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const day = 86400000;
  const diff = startOfDay(now) - startOfDay(d);
  if (diff < 0) return '今天';
  if (diff < day) return '今天';
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return '最近 7 天';
  return '更早';
}

/** 消息角色 → codicon 名称 */
export function roleIcon(role: string): string {
  if (role === 'user') return 'account';
  if (role === 'assistant') return 'sparkle';
  return 'info';
}

/** 消息角色 → 中文标题 */
export function roleTitle(role: string): string {
  if (role === 'user') return '你';
  if (role === 'assistant') return '助手';
  return '系统';
}

/** 斜杠命令气泡的状态徽标 */
export function commandBadge(m: ViewMessage): { text: string; cls: string } {
  if (m.cmdState !== 'done') return { text: '执行中', cls: 'is-run' };
  return m.cmdOk ? { text: '成功', cls: 'is-ok' } : { text: '失败', cls: 'is-fail' };
}

/** 目标相位徽标文本 */
export function goalPhaseLabel(phase: string): string {
  switch (phase) {
    case 'active':
      return '进行中';
    case 'paused':
      return '已暂停';
    case 'blocked':
      return '受阻';
    case 'complete':
      return '已完成';
    default:
      return phase;
  }
}

/** 顶栏连接状态点的颜色——一律用 --vscode-* 主题变量 */
export function connectionColor(connection: string): string {
  switch (connection) {
    case 'ready':
      return 'var(--vscode-charts-green, var(--vscode-descriptionForeground))';
    case 'error':
      return 'var(--vscode-errorForeground, var(--vscode-charts-red))';
    case 'offline':
      return 'var(--vscode-charts-red, var(--vscode-descriptionForeground))';
    case 'connecting':
      return 'var(--vscode-charts-yellow, var(--vscode-descriptionForeground))';
    default:
      return 'var(--vscode-descriptionForeground)';
  }
}
