import { ConflictError } from "./errors";

export type Entity =
  | "task"
  | "agent"
  | "insight"
  | "approval"
  | "council"
  | "dissent"
  | "apprentice"
  | "run";

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
