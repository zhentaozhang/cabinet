import { ConflictError } from "./errors";
import { GOAL_TRANSITIONS } from "@/contracts/goals";
import type { GoalStatus } from "@/contracts/goals";

// 目标的状态图与动作表定义在 contracts/goals.ts：客户端要为"哪些按钮能点"
// 做出和服务端一样的判断，而 src/lib/domain/state.ts 会顺带把 errors.ts（进而
// 把 node:async_hooks 的日志上下文）拉进浏览器包。契约模块没有运行时依赖，
// 两边引用同一份表，也就不会出现前后端各判一套的情况。
export {
  GOAL_TRANSITIONS,
  GOAL_ACTION_TARGET,
  GOAL_ACTION_EDGES,
  canRunGoalAction,
  allowedGoalActions,
} from "@/contracts/goals";

export type Entity =
  | "task"
  | "agent"
  | "insight"
  | "approval"
  | "council"
  | "dissent"
  | "apprentice"
  | "run"
  | "goal";

/**
 * Single source of truth for allowed state transitions.
 * Services must call assertTransition before any status update.
 */
export const TRANSITIONS: Record<
  Entity,
  Record<string, readonly string[]>
> = {
  task: {
    planned: ["assigned", "suggested", "submitted", "cancelled"],
    assigned: [
      "running",
      "awaiting_approval",
      "suggested",
      "submitted",
      "cancelled",
    ],
    suggested: ["planned", "cancelled"],
    awaiting_approval: ["approved", "cancelled", "planned"],
    approved: ["running", "cancelled"],
    // A run in flight is interruptible: the user may stop work that is going
    // nowhere, and the cancel command closes the run and its job in the same
    // transaction. Without this edge, a task whose worker died mid-run could
    // never be closed at all.
    // `planned` is the recovery rollback: a run whose process died rewinds its
    // task through this table rather than with a bare UPDATE (see
    // `recoverStaleRuns`), so the machine stays the single source of truth.
    running: ["submitted", "failed", "cancelled", "planned"],
    submitted: ["auditing", "rejected"],
    auditing: ["accepted", "rejected"],
    // Cancelling a rejected task is giving up on it, which must be possible.
    rejected: ["running", "failed", "planned", "submitted", "cancelled"],
    failed: ["planned", "cancelled"],
    accepted: ["done"],
    done: [],
    cancelled: [],
  },
  agent: {
    probation: ["active", "paused", "retired"],
    active: ["paused", "retired"],
    paused: ["active", "retired"],
    retired: [],
  },
  insight: {
    proposed: ["applied", "rejected"],
    applied: ["rolled_back"],
    rejected: [],
    rolled_back: [],
  },
  approval: {
    pending: ["approved", "rejected", "expired"],
    approved: [],
    rejected: [],
    expired: [],
  },
  council: {
    open: ["decided"],
    decided: [],
  },
  dissent: {
    pending: ["vindicated", "invalidated"],
    vindicated: [],
    invalidated: [],
  },
  apprentice: {
    shadowing: ["drafting", "retired"],
    drafting: ["examining", "retired"],
    examining: ["active", "drafting", "practice_passed", "retired"],
    // A practice pass only ends the simulated track. Promotion is a separate
    // decision made by `graduateApprentice`, which requires real audit
    // evidence collected after the pass (decideGraduation), so the edge exists
    // but no caller can take it on the practice result alone.
    practice_passed: ["active", "retired"],
    active: ["retired"],
    retired: [],
  },
  run: {
    queued: ["running", "cancelled"],
    running: ["succeeded", "failed", "cancelled"],
    succeeded: [],
    failed: [],
    cancelled: [],
  },
  goal: GOAL_TRANSITIONS,
};

export function canTransition(
  entity: Entity,
  from: string,
  to: string,
): boolean {
  return TRANSITIONS[entity][from]?.includes(to) ?? false;
}

export function assertTransition(
  entity: Entity,
  from: string,
  to: string,
): void {
  if (!canTransition(entity, from, to)) {
    throw new ConflictError(
      `Invalid ${entity} transition: ${from} → ${to}`,
    );
  }
}

export function isTerminal(entity: Entity, status: string): boolean {
  return (TRANSITIONS[entity][status] ?? []).length === 0;
}
