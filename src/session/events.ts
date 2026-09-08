// src/session/events.ts — DSH 事件载荷的防御式提取
// 真实帧形状以 docs/api/fixtures/ 与 probe 抓帧为准；字段形状可能随版本演化，
// 这里全部用「能取就取、取不到回退 JSON」的防御策略，保证任何形状都不炸 UI。
export interface RawEvent {
  type: string;
  seq: number;
  time?: number;
  data?: unknown;
  surfaceOp?: unknown;
  sourceEventSeqs?: number[];
  ignorable?: boolean;
}

export interface SnapshotEvent {
  type: 'snapshot';
  header?: { id?: string; createdAt?: number; cwd?: string };
  cursor?: number;
  records?: { type: string; event?: RawEvent; chunks?: unknown }[];
  hasMore?: boolean;
  projections?: unknown;
}

/** 从一个任意 data 载荷里尽力提取可读文本 */
export function textOf(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data === null || data === undefined) return '';
  if (typeof data !== 'object') return String(data);
  const d = data as Record<string, unknown>;
  // 常见几种形状：{text} / {content:[{type:'text',text},…]} / {message} / {chunkText}
  for (const key of ['text', 'message', 'chunkText', 'contentText']) {
    const v = d[key];
    if (typeof v === 'string' && v) return v;
  }
  const content = d['content'];
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (typeof c === 'string') parts.push(c);
      else if (c && typeof c === 'object') {
        const o = c as Record<string, unknown>;
        if (o['text'] !== undefined) parts.push(String(o['text']));
        else if (o['type'] === 'text' && o['text'] !== undefined) parts.push(String(o['text']));
      }
    }
    if (parts.length > 0) return parts.join('');
  }
  const compact = JSON.stringify(data);
  return compact && compact !== '{}' ? compact : '';
}

/** 工具调用参数（尽力提取摘要；失败回退 JSON） */
export function toolCallText(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const d = data as Record<string, unknown>;
  const name = d['name'] ?? d['tool'] ?? d['toolName'] ?? '';
  const input = d['input'] ?? d['args'] ?? d['arguments'] ?? d['params'];
  if (typeof name === 'string' && name) {
    const args = typeof input === 'string' ? input : textOf(input);
    return args ? `${name}(${args.slice(0, 200)})` : name;
  }
  return textOf(data);
}

/** 由事件 type 派生一个简短状态行（不会出现的事件类型则原样放回） */
const STATUS_LABEL: Record<string, string> = {
  'turn/start': '回合开始',
  'turn/end': '回合结束',
  'step/start': '步骤开始',
  'step/end': '步骤结束',
  'todo/write': '待办更新',
  'compaction/prune': '上下文压缩',
  'llm/retry': '重试中',
  'llm/retry-started': '重试开始',
  'agent/inbox/spliced': '收件箱更新',
  'request/header': '请求开始',
};

export function statusLineOf(type: string): string | null {
  if (type in STATUS_LABEL) return STATUS_LABEL[type];
  if (/approval|permission/i.test(type)) return `需要审批（${type}）`;
  return null;
}
