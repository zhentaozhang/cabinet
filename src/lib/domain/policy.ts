import { matchStandingGrant, type StandingGrant } from "./standing-grants";

export type PolicyEffect = "allow" | "suggest" | "require_approval" | "deny";

export type PolicyDecision = {
  effect: PolicyEffect;
  reason: string;
  /**
   * Set when a standing policy (a previous "yes", bounded by expiry, budget and
   * revocation) is what lifted the approval gate. The caller records the use so
   * the ceiling actually decrements.
   */
  standingGrantId?: string;
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
  /** A revoked grant is not permission — it is a record of permission. */
  revokedAt?: Date | null;
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

export type DissentConfig = {
  trustBonus: number;
  chiefPenalty: number;
  precedentSalience: number;
};

export type LearningConfig = {
  progressWeights: {
    acceptedTasks: number;
    recall: number;
    checkins: number;
  };
  targetCheckinsPerWeek: number;
  nextTask: {
    estimateMin: number;
    minRecallScore: number;
    minWords: number;
    maxErrorTags: number;
    retestAfterDays: number;
  };
};

export type ReflectionConfig = {
  windowDays: number;
  minRejectEvents: number;
  minTaskSample: number;
  eveningHour: number;
  eveningCompletionThreshold: number;
  lowEnergyThreshold: number;
  budgetPressureRatio: number;
  confidence: number;
};

export type PolicyConfig = {
  autonomy: {
    minTrust: number;
    minSuccesses: number;
    minAuditPassRate: number;
    /** Eligible audit samples required before a pass rate means anything. */
    minAuditSamples: number;
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
    maxOutputTokens: number;
    maxRunCents: number;
  };
  council: CouncilConfig;
  reflection: ReflectionConfig;
  dissent: DissentConfig;
  learning: LearningConfig;
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
    minAuditSamples: 5,
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
    maxOutputTokens: 1200,
    maxRunCents: 50,
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
  reflection: {
    windowDays: 7,
    minRejectEvents: 1,
    minTaskSample: 2,
    eveningHour: 20,
    eveningCompletionThreshold: 0.5,
    lowEnergyThreshold: 2,
    budgetPressureRatio: 0.8,
    confidence: 0.72,
  },
  dissent: {
    trustBonus: 15,
    chiefPenalty: 5,
    precedentSalience: 0.9,
  },
  learning: {
    progressWeights: {
      acceptedTasks: 0.5,
      recall: 0.3,
      checkins: 0.2,
    },
    targetCheckinsPerWeek: 5,
    nextTask: {
      estimateMin: 25,
      minRecallScore: 0.6,
      minWords: 60,
      maxErrorTags: 3,
      retestAfterDays: 3,
    },
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

/**
 * The one grant check.
 *
 * Both `decideRun` and `planTools` must agree on what a grant means, so this is
 * exported rather than copied: a second implementation drifts on exactly the
 * interesting cases (a revoked grant is a record of permission, not
 * permission; `*` covers every resource; `execute`/`admin` outrank `write`).
 */
export function hasGrant(
  grants: Grant[],
  resource: string,
  need: "read" | "write",
): boolean {
  const required = SCOPE_RANK[need];
  return grants.some((grant) => {
    if (grant.revokedAt) return false;
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
  /** Standing policies created from earlier approvals. Optional: none at all. */
  standingGrants?: StandingGrant[];
  budget: { limitCents: number; spentCents: number };
  approval: ApprovalState;
  config: PolicyConfig;
  /** Injected clock, so expiry is testable. Defaults to now. */
  now?: Date;
  /** The user's timezone, so an expiry date is not shown a day off. */
  timeZone?: string;
}): PolicyDecision {
  const { actor, task, grants, budget, approval, config } = input;
  const standingGrants = input.standingGrants ?? [];

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

  // A user decision is a hard signal: rejection blocks, a pending request
  // waits. Approval is deliberately NOT checked here — see `needApproval`,
  // which runs only after the structural checks, so a user's approval can
  // lift the approval requirement and nothing else (no revoked grant, no
  // forbidden action type, no unknown action gets through).
  if (approval?.status === "rejected") {
    return deny("Approval was rejected.");
  }

  if (approval?.status === "pending") {
    return requireApproval("Approval is already pending.");
  }

  /**
   * An approval is the user saying "act now". It may therefore lift only the
   * *autonomy gate* — `require_approval` (needs a yes) and `suggest` (the agent
   * is only allowed to propose at this level). It never turns a `deny` into an
   * allow, so a revoked grant, a forbidden action type or a second use of a
   * consumed approval stays blocked.
   */
  const action = normalizeAction(task.actionType);
  if (action === "unknown") {
    return deny(`Unknown action type: ${task.actionType}.`);
  }

  // Standing policies lift exactly one thing: "ask me every time". They never
  // promote an L1 agent (a `suggest` stays a suggestion), never mint a resource
  // permission, and never cover admin/audit work.
  const standing = matchStandingGrant({
    grants: standingGrants,
    resource: task.resource,
    action,
    estimatedCostCents: task.estimatedCostCents,
    now: input.now ?? new Date(),
    timeZone: input.timeZone,
  });

  const gate = (decision: PolicyDecision): PolicyDecision => {
    if (decision.effect !== "require_approval" && decision.effect !== "suggest") {
      return decision;
    }
    if (approval?.status === "approved") {
      if (!approval.consumedAt) {
        return allow(`Execution approved by user. ${decision.reason}`);
      }
      // A spent approval is spent — unless the user also turned it into a
      // standing policy, in which case that policy is what covers this run.
      if (decision.effect === "require_approval" && standing) {
        return {
          effect: "allow",
          reason: `${standing.reason}：${decision.reason}`,
          standingGrantId: standing.grantId,
        };
      }
      return deny("Approval has already been consumed.");
    }
    if (decision.effect === "require_approval" && standing) {
      return {
        effect: "allow",
        reason: `${standing.reason}：${decision.reason}`,
        standingGrantId: standing.grantId,
      };
    }
    return decision;
  };

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
    return gate(suggest("L1 can only suggest internal writes."));
  }

  if (action === "external_action") {
    if (level <= 1) return gate(suggest("L1 can only suggest external actions."));
    if (level === 2) {
      return gate(requireApproval("L2 external action requires approval."));
    }
  }

  if (action === "spend") {
    if (level <= 1) return deny("L1 cannot spend.");
    if (level === 2) {
      return gate(requireApproval("L2 spend requires approval."));
    }
    const threshold =
      task.approvalThresholdCents ?? config.budget.approvalThresholdCents;
    if (task.estimatedCostCents > threshold) {
      return gate(requireApproval("Spend exceeds approval threshold."));
    }
  }

  if (task.requiresApproval) {
    return gate(requireApproval("Task is marked as requiring approval."));
  }

  if (
    task.estimatedCostCents > 0 &&
    budget.spentCents + task.estimatedCostCents > budget.limitCents
  ) {
    if (level <= 1) {
      return deny("Estimated spend exceeds budget at L1.");
    }
    // Deliberately NOT gated: a standing policy is "the same action as last
    // time", never "more money than the budget allows". This is the one check
    // that must always surface to the user.
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

/** The finite set of reasons an upgrade can be refused. */
export type UpgradeDenialCode =
  | "insufficient_samples"
  | "low_pass_rate"
  | "low_trust"
  | "too_few_successes"
  | "not_eligible_role"
  | "retired"
  | "paused";

export type UpgradeDecision = PolicyDecision & {
  /** Null when the upgrade is allowed. */
  code: UpgradeDenialCode | null;
  /** Eligible audit samples the pass rate was measured over. */
  samples: number;
  /** Pass rate over eligible samples; 0 when there are none. */
  passRate: number;
};

/**
 * Decide whether an agent can move to targetLevel.
 *
 * The audit window is supplied by the caller and must already be filtered to
 * eligible samples (see `isEligibleAuditSample`) — an empty window is not a
 * zero pass rate, it is missing evidence.
 */
export function decideUpgrade(input: {
  actor: Actor;
  targetLevel: number;
  auditPassRate: number;
  auditSamples: number;
  config: PolicyConfig;
}): UpgradeDecision {
  const { actor, targetLevel, auditPassRate, auditSamples, config } = input;
  const outcome = (decision: PolicyDecision, code: UpgradeDenialCode | null) => ({
    ...decision,
    code,
    samples: auditSamples,
    passRate: auditPassRate,
  });

  if (targetLevel > 3) {
    return outcome(deny("L4 is not available in this MVP."), "not_eligible_role");
  }

  if (targetLevel <= actor.autonomyLevel) {
    return outcome(allow("Downgrade or same level is always allowed."), null);
  }

  if (actor.status === "retired" || actor.lifecycleStage === "retired") {
    return outcome(deny("退休的 Agent 不能升级。"), "retired");
  }

  if (actor.status === "paused") {
    return outcome(deny("Agent 已暂停，先恢复在岗再谈升级。"), "paused");
  }

  if (actor.status !== "active" || actor.lifecycleStage !== "active") {
    return outcome(
      deny("只有正式在岗的 Agent 才能升级（学徒需先通过转正考核）。"),
      "not_eligible_role",
    );
  }

  if (actor.trustScore < config.autonomy.minTrust) {
    return outcome(
      deny(
        `Trust ${actor.trustScore.toFixed(0)} is below ${config.autonomy.minTrust}.`,
      ),
      "low_trust",
    );
  }

  if (actor.successCount < config.autonomy.minSuccesses) {
    return outcome(
      deny(
        `Success count ${actor.successCount} is below ${config.autonomy.minSuccesses}.`,
      ),
      "too_few_successes",
    );
  }

  // Missing evidence must not look like a failing rate: check the sample floor
  // first so the operator sees "not enough real samples" rather than "0%".
  if (auditSamples < config.autonomy.minAuditSamples) {
    return outcome(
      deny(
        `符合条件的审计样本 ${auditSamples} 个，少于要求的 ${config.autonomy.minAuditSamples} 个。`,
      ),
      "insufficient_samples",
    );
  }

  if (auditPassRate < config.autonomy.minAuditPassRate) {
    return outcome(
      deny(
        `Audit pass rate ${(auditPassRate * 100).toFixed(1)}% is below ${(
          config.autonomy.minAuditPassRate * 100
        ).toFixed(0)}%.`,
      ),
      "low_pass_rate",
    );
  }

  return outcome(allow("Agent meets upgrade thresholds."), null);
}

/** The finite set of reasons a 转正 (apprentice → active) can be refused. */
export type GraduationDenialCode =
  | "no_practice_pass"
  | "retired"
  | "paused"
  | "low_trust"
  | "too_few_successes"
  | "insufficient_samples"
  | "low_pass_rate";

export type GraduationDecision = PolicyDecision & {
  /** Null when graduation is allowed. */
  code: GraduationDenialCode | null;
  samples: number;
  passRate: number;
};

/**
 * Decide whether an apprentice who practice-passed the deterministic exam may
 * become a real, on-duty Agent.
 *
 * This is the "separately designed real evaluation" the exam comment points at:
 * the practice exam only proves the drill was completed, so graduation is
 * judged on evidence the apprentice produced *after* it — audited tasks that
 * count as real model execution — plus the same trust/success floors a level
 * upgrade uses. Without this, `practice_passed` had exactly one exit
 * (retirement) and the 「学徒需先通过转正考核」 message in `decideUpgrade` pointed
 * at nothing.
 *
 * `auditPassRate`/`auditSamples` come from an already-filtered audit window,
 * same contract as `decideUpgrade`: an empty window is missing evidence, not a
 * zero pass rate, so the sample floor is checked before the rate.
 */
export function decideGraduation(input: {
  actor: Actor;
  auditPassRate: number;
  auditSamples: number;
  config: PolicyConfig;
}): GraduationDecision {
  const { actor, auditPassRate, auditSamples, config } = input;
  const outcome = (decision: PolicyDecision, code: GraduationDenialCode | null) => ({
    ...decision,
    code,
    samples: auditSamples,
    passRate: auditPassRate,
  });

  if (actor.status === "retired" || actor.lifecycleStage === "retired") {
    return outcome(deny("退休的学徒不能转正。"), "retired");
  }

  if (actor.status === "paused") {
    return outcome(deny("学徒已暂停，先恢复再谈转正。"), "paused");
  }

  if (actor.lifecycleStage !== "practice_passed") {
    return outcome(
      deny(
        `转正需要先通过练习考核，当前阶段是 ${actor.lifecycleStage}。`,
      ),
      "no_practice_pass",
    );
  }

  if (actor.trustScore < config.autonomy.minTrust) {
    return outcome(
      deny(
        `信任分 ${actor.trustScore.toFixed(0)} 低于 ${config.autonomy.minTrust}，转正需要真实任务积累。`,
      ),
      "low_trust",
    );
  }

  if (actor.successCount < config.autonomy.minSuccesses) {
    return outcome(
      deny(
        `成功任务 ${actor.successCount} 少于要求的 ${config.autonomy.minSuccesses}。`,
      ),
      "too_few_successes",
    );
  }

  if (auditSamples < config.autonomy.minAuditSamples) {
    return outcome(
      deny(
        `有效审计样本 ${auditSamples} 个，少于要求的 ${config.autonomy.minAuditSamples} 个。`,
      ),
      "insufficient_samples",
    );
  }

  if (auditPassRate < config.autonomy.minAuditPassRate) {
    return outcome(
      deny(
        `审计通过率 ${(auditPassRate * 100).toFixed(1)}% 低于 ${(
          config.autonomy.minAuditPassRate * 100
        ).toFixed(0)}%。`,
      ),
      "low_pass_rate",
    );
  }

  return outcome(allow("练习通过，且真实审计证据达标，可以转正。"), null);
}
