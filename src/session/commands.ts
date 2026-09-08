// src/session/commands.ts — 斜杠命令平面（M6b）
// 契约（装机包 dsh-commands/typert.remote-client.d.ts + 活体 probe 实证）：
//   commands/list(agentId)          → CommandDescriptor[]   {name,description,input?:{hint,images?}}
//   commands/execute(agentId,line,images) → CommandExecution | undefined
//     line 是含前导 '/' 的整行（如 '/goal 修复登录页'）；undefined = 未知/格式错误命令。
// 信封均为扁平 args（无 request 包装），见 docs/design/命令与审批与目标.md §1。
import { isRpcOk, unary } from '../rpc/unary';

export interface CommandInputDescriptor {
  hint?: string;
  images?: boolean;
}

/** 一个可发现的斜杠命令（与 dsh-commands/types CommandDescriptor 对齐） */
export interface CommandDescriptor {
  name: string;
  description: string;
  input?: CommandInputDescriptor;
}

export interface CommandExecutionResult {
  commandId: string;
  ok: boolean;
  text?: string;
}

export interface CommandApiDeps {
  origin: string;
  cookie: string;
  fetchImpl?: typeof fetch;
}

/** 拉取某会话（agent）的命令目录。失败抛错（含 agent 未激活等业务错误）。 */
export async function listCommands(
  deps: CommandApiDeps,
  sessionId: string,
): Promise<CommandDescriptor[]> {
  const res = await unary<CommandDescriptor[]>(
    deps.origin,
    deps.cookie,
    'commands/list',
    { agentId: sessionId },
    10000,
    deps.fetchImpl,
  );
  if (!isRpcOk(res)) {
    throw new Error(`commands/list 失败: ${res.error.code} ${res.error.message}`);
  }
  return Array.isArray(res.value) ? res.value : [];
}

/**
 * 执行一条斜杠命令（整行）。返回归一化结果：
 * - value === undefined（未知/格式错误）→ ok:false + 说明文本
 * - handler 返回 success/error → ok 按 kind 归一
 * 错误（HTTP/网关拒绝）→ 抛错，由调用方记日志。
 */
export async function runCommand(
  deps: CommandApiDeps,
  sessionId: string,
  line: string,
  images: readonly unknown[] = [],
): Promise<CommandExecutionResult> {
  const res = await unary<{
    commandId?: string;
    result?: { kind?: string; text?: string; sourceEventSeq?: number };
  }>(
    deps.origin,
    deps.cookie,
    'commands/execute',
    { agentId: sessionId, line, images },
    15000,
    deps.fetchImpl,
  );
  if (!isRpcOk(res)) {
    throw new Error(`commands/execute 失败: ${res.error.code} ${res.error.message}`);
  }
  const v = res.value;
  if (!v || typeof v !== 'object') {
    return { commandId: '', ok: false, text: `未知或格式错误的命令：${line}` };
  }
  const commandId = typeof v.commandId === 'string' ? v.commandId : '';
  const kind = v.result?.kind;
  const text = typeof v.result?.text === 'string' ? v.result.text : undefined;
  return { commandId, ok: kind === 'success', text };
}
