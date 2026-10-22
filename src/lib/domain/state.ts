import { ConflictError } from "./errors";

export type Entity =
  | "task"
  | "agent"
  | "insight"
  | "approval"
  | "council"
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
    planned: ["assigned", "suggested", "cancelled"],
    assigned: ["running", "awaiting_approval", "suggested", "cancelled"],
    suggested: ["planned", "cancelled"],
    awaiting_approval: ["approved", "cancelled"],
    approved: ["running", "cancelled"],
    running: ["submitted", "failed"],
    submitted: ["auditing", "rejected"],
    auditing: ["accepted", "rejected"],
    rejected: ["running", "failed"],
    accepted: ["done"],
    done: [],
    failed: [],
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
  apprentice: {
    shadowing: ["drafting", "retired"],
    drafting: ["examining", "retired"],
    examining: ["active", "drafting", "retired"],
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
