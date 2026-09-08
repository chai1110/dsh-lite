// src/session/goals.ts — 目标控制 Remote（M6d）
// 契约（装机包 dsh-goal/typert.remote-client.d.ts + 活体 probe 实证）：
//   goals/create(agentId, request:{objective,maxGoalRounds?})   —— 创建走 /goal 命令，不直接调
//   goals/edit(agentId, ref, request:{objective?,maxGoalRounds?})
//   goals/pause|resume|clear|complete(agentId, ref:{id,revision})
// 信封扁平（agentId/ref 顶层），见 docs/design/命令与审批与目标.md §1。
import { isRpcOk, unary } from '../rpc/unary';
import type { GoalBrief, GoalPhase } from '../model';

export type { GoalBrief, GoalPhase };

/** 目标并发安全引用（CAS 用；来自当前投影 goal.id + goal.revision） */
export interface GoalRef {
  id: string;
  revision: number;
}

export interface GoalApiDeps {
  origin: string;
  cookie: string;
  fetchImpl?: typeof fetch;
}

export type GoalMutation = 'pause' | 'resume' | 'clear';

/** 对当前目标做 pause/resume/clear（ref 由调用方从投影取，RPC 自带 CAS 防并发漂移）。 */
export async function mutateGoal(
  deps: GoalApiDeps,
  sessionId: string,
  ref: GoalRef,
  action: GoalMutation,
): Promise<void> {
  const res = await unary<unknown>(
    deps.origin,
    deps.cookie,
    `goals/${action}`,
    { agentId: sessionId, ref },
    10000,
    deps.fetchImpl,
  );
  if (!isRpcOk(res)) {
    throw new Error(`goals/${action} 失败: ${res.error.code} ${res.error.message}`);
  }
}
