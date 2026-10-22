export type PolicyEffect = "allow" | "suggest" | "require_approval" | "deny";

export type PolicyDecision = {
  effect: PolicyEffect;
  reason: string;
};

export type Actor = {
  id: string;
  role: string;
  status: string;
  lifecycleStage: string;
  autonomyLevel: number;
  trustScore: number;
  successCount: number;
};

export type TaskPolicy = {
  assigneeId: string | null;
  auditorId: string | null;
  actionType: string;
  resource: string;
  requiresApproval: boolean;
  estimatedCostCents: number;
  approvalThresholdCents: number | null;
  status: string;
};

export type Grant = {
  resource: string;
  scope: string;
};

export type ApprovalState = {
  status: string;
  consumedAt: Date | null;
} | null;

export type CouncilConfig = {
  roleWeights: Record<string, number>;
  dimensionWeights: {
    feasibility: number;
    costEfficiency: number;
    evidenceQuality: number;
    robustness: number;
  };
  score: {
    base: number;
    goalWeight: number;
    trustWeight: number;
    evidencePoints: number;
    rejectPenalty: number;
    pausePenalty: number;
    budgetPressureWeight: number;
  };
  minPositions: number;
  minEnergy: number;
  dissentWindowDays: number;
  dissentBudgetRatio: number;
};

export type PolicyConfig = {
  autonomy: {
    minTrust: number;
    minSuccesses: number;
    minAuditPassRate: number;
  };
  audit: {
    rejectStreakLimit: number;
    passRateWindow: number;
  };
  budget: {
    weeklyLimitCents: number;
    approvalThresholdCents: number;
  };
  management: {
    minutesPerDecision: number;
  };
  cost: {
    perMinuteCents: number;
    centsPer1kTokens: number;
  };
  council: CouncilConfig;
};

/**
 * Seed/test defaults only. Runtime decisions must load config from policy_config.
 * Do not import this in services.
 */
export const SEED_POLICY_CONFIG: PolicyConfig = {
  autonomy: {
    minTrust: 70,
    minSuccesses: 3,
    minAuditPassRate: 0.9,
  },
  audit: {
    rejectStreakLimit: 2,
    passRateWindow: 20,
  },
  budget: {
    weeklyLimitCents: 60000,
    approvalThresholdCents: 20000,
  },
  management: {
    minutesPerDecision: 0.5,
  },
  cost: {
    perMinuteCents: 2,
    centsPer1kTokens: 0.8,
  },
  council: {
    roleWeights: {
      chief: 1.1,
      researcher: 1,
      coach: 1,
      treasurer: 1.1,
      critic: 1.2,
      auditor: 0.8,
    },
    dimensionWeights: {
      feasibility: 0.3,
      costEfficiency: 0.25,
      evidenceQuality: 0.25,
      robustness: 0.2,
    },
    score: {
      base: 50,
      goalWeight: 0.3,
      trustWeight: 0.2,
      evidencePoints: 20,
      rejectPenalty: 15,
      pausePenalty: 30,
      budgetPressureWeight: 100,
    },
    minPositions: 3,
    minEnergy: 3,
    dissentWindowDays: 7,
    dissentBudgetRatio: 0.8,
  },
};

export type NormalizedAction =
  | "internal_read"
  | "internal_write"
  | "external_action"
  | "spend"
  | "audit"
  | "admin"
  | "unknown";

export function normalizeAction(actionType: string): NormalizedAction {
  switch (actionType) {
    case "internal_read":
      return "internal_read";
    case "internal":
    case "internal_write":
      return "internal_write";
    case "external":
    case "external_action":
    case "publish":
    case "message":
    case "book":
      return "external_action";
    case "spend":
      return "spend";
    case "audit":
      return "audit";
    case "admin":
      return "admin";
    default:
      return "unknown";
  }
}

function deny(reason: string): PolicyDecision {
  return { effect: "deny", reason };
}

function suggest(reason: string): PolicyDecision {
  return { effect: "suggest", reason };
}

function requireApproval(reason: string): PolicyDecision {
  return { effect: "require_approval", reason };
}

function allow(reason: string): PolicyDecision {
  return { effect: "allow", reason };
}

const SCOPE_RANK: Record<string, number> = {
  read: 1,
  write: 2,
  execute: 2,
  admin: 3,
};

function hasGrant(
  grants: Grant[],
  resource: string,
  need: "read" | "write",
): boolean {
  const required = SCOPE_RANK[need];
  return grants.some((grant) => {
    if (grant.resource !== resource && grant.resource !== "*") return false;
    return (SCOPE_RANK[grant.scope] ?? 0) >= required;
  });
}

/**
 * Decide whether an agent may execute a task.
 * Pure function: no DB, no clock, no environment.
 */
export function decideRun(input: {
  actor: Actor;
  task: TaskPolicy;
  grants: Grant[];
  budget: { limitCents: number; spentCents: number };
  approval: ApprovalState;
  config: PolicyConfig;
}): PolicyDecision {
  const { actor, task, grants, budget, approval, config } = input;

  if (actor.status !== "active") {
    return deny(`Agent is ${actor.status}, not active.`);
  }

  if (actor.lifecycleStage !== "active") {
    return deny(`Agent lifecycle is ${actor.lifecycleStage}.`);
  }

  if (task.assigneeId && task.assigneeId !== actor.id) {
    return deny("Actor is not the assignee.");
  }

  if (task.auditorId && task.auditorId === actor.id) {
    return deny("Auditor cannot execute the task they audit.");
  }

  if (approval?.status === "approved") {
    if (approval.consumedAt) {
      return deny("Approval has already been consumed.");
    }
    return allow("Execution approved.");
  }

  if (approval?.status === "pending") {
    return requireApproval("Approval is already pending.");
  }

  if (approval?.status === "rejected") {
    return deny("Approval was rejected.");
  }

  const action = normalizeAction(task.actionType);
  if (action === "unknown") {
    return deny(`Unknown action type: ${task.actionType}.`);
  }

  const requiredScope = action === "internal_read" ? "read" : "write";
  if (!hasGrant(grants, task.resource, requiredScope)) {
    return deny(
      `Missing grant for resource: ${task.resource} (${requiredScope}).`,
    );
  }

  if (action === "admin") {
    return deny("Admin actions are user-only.");
  }

  if (action === "audit") {
    return deny("Audit actions must use the audit path.");
  }

  const level = actor.autonomyLevel;

  if (action === "internal_read") {
    return allow("Read-only internal action.");
  }

  if (action === "internal_write") {
    if (level >= 2) return allow("Internal write at L2+.");
    return suggest("L1 can only suggest internal writes.");
  }

  if (action === "external_action") {
    if (level <= 1) return suggest("L1 can only suggest external actions.");
    if (level === 2) {
      return requireApproval("L2 external action requires approval.");
    }
  }

  if (action === "spend") {
    if (level <= 1) return deny("L1 cannot spend.");
    if (level === 2) {
      return requireApproval("L2 spend requires approval.");
    }
    const threshold =
      task.approvalThresholdCents ?? config.budget.approvalThresholdCents;
    if (task.estimatedCostCents > threshold) {
      return requireApproval("Spend exceeds approval threshold.");
    }
  }

  if (task.requiresApproval) {
    return requireApproval("Task is marked as requiring approval.");
  }

  if (
    task.estimatedCostCents > 0 &&
    budget.spentCents + task.estimatedCostCents > budget.limitCents
  ) {
    if (level <= 1) {
      return deny("Estimated spend exceeds budget at L1.");
    }
    return requireApproval("Estimated spend exceeds remaining budget.");
  }

  return allow("Policy allows execution.");
}

/**
 * Decide whether an agent may audit a task.
 * Enforces separation of duties and auditor identity.
 */
export function decideAudit(input: {
  actor: Actor;
  task: TaskPolicy;
}): PolicyDecision {
  const { actor, task } = input;

  if (actor.role !== "auditor") {
    return deny("Only the Auditor role can audit.");
  }

  if (actor.status !== "active") {
    return deny(`Auditor is ${actor.status}, not active.`);
  }

  if (task.auditorId !== actor.id) {
    return deny("Actor is not the assigned auditor.");
  }

  if (task.assigneeId === actor.id) {
    return deny("Executor cannot audit its own work.");
  }

  if (task.status !== "submitted") {
    return deny("Task is not submitted for audit.");
  }

  return allow("Audit allowed.");
}

/**
 * Decide whether an agent can move to targetLevel.
 * Audit pass rate is calculated by the caller from audit events.
 */
export function decideUpgrade(input: {
  actor: Actor;
  targetLevel: number;
  auditPassRate: number;
  config: PolicyConfig;
}): PolicyDecision {
  const { actor, targetLevel, auditPassRate, config } = input;

  if (targetLevel > 3) {
    return deny("L4 is not available in this MVP.");
  }

  if (targetLevel <= actor.autonomyLevel) {
    return allow("Downgrade or same level is always allowed.");
  }

  if (actor.status !== "active" || actor.lifecycleStage !== "active") {
    return deny("Agent is not active.");
  }

  if (actor.trustScore < config.autonomy.minTrust) {
    return deny(
      `Trust ${actor.trustScore.toFixed(0)} is below ${config.autonomy.minTrust}.`,
    );
  }

  if (actor.successCount < config.autonomy.minSuccesses) {
    return deny(
      `Success count ${actor.successCount} is below ${config.autonomy.minSuccesses}.`,
    );
  }

  if (auditPassRate < config.autonomy.minAuditPassRate) {
    return deny(
      `Audit pass rate ${(auditPassRate * 100).toFixed(1)}% is below ${(
        config.autonomy.minAuditPassRate * 100
      ).toFixed(0)}%.`,
    );
  }

  return allow("Agent meets upgrade thresholds.");
}
