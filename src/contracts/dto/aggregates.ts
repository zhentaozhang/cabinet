import { z } from "zod";

import { isoDateTime } from "./common";
import {
  agentDtoSchema,
  approvalDtoSchema,
  artifactDtoSchema,
  auditEventDtoSchema,
  budgetViewDtoSchema,
  checkinDtoSchema,
  councilDtoSchema,
  councilPositionDtoSchema,
  dissentDtoSchema,
  retrievedEvidenceDtoSchema,
  goalDtoSchema,
  grantDtoSchema,
  insightDtoSchema,
  memoryDtoSchema,
  policyConfigDtoSchema,
  profileDtoSchema,
  reviewDtoSchema,
  runDtoSchema,
  skillDtoSchema,
  stepDtoSchema,
  taskDtoSchema,
  taskOverrideRecordSchema,
  userDtoSchema,
} from "./entities";

/**
 * Page-shaped read models.
 *
 * One endpoint per screen aggregate — never one per table — so the frontend
 * keeps a single round trip per page after the split, exactly like it has today
 * with in-process engine calls.
 */

/**
 * Units are mixed on purpose and documented per field, because a wrong `* 100`
 * renders a plausible but false number on a page people trust.
 *   - ratios (0–1): `recallAvg`
 *   - percentages (0–100): `adherence`, `retestPassRate`, `goalProgress`,
 *     `auditRejectRate`
 *   - money: `costCents`, `search.priceCents`, `search.estimatedCents` (cents)
 */
export const weeklyMetricsSchema = z.object({
  weekKey: z.string(),
  aao: z.number(),
  /**
   * Already a percentage (0–100), not a 0–1 ratio.
   * Null when no tasks were planned in the window.
   */
  adherence: z.number().nullable(),
  /** Null when there are neither measured actions nor decision samples. */
  managementMinutes: z.number().nullable(),
  managementMinutesSource: z.enum(["measured", "estimated"]),
  studyMinutes: z.number(),
  /**
   * A 0–1 ratio, unlike `adherence` and `retestPassRate` below — the source is
   * `checkins.recallScore`, constrained to `>= 0 AND <= 1`. Multiply by 100 to
   * display it. Null when there are no check-in samples.
   */
  recallAvg: z.number().nullable(),
  learningTasks: z.number(),
  /**
   * Already a percentage (0–100), not a 0–1 ratio.
   * Null when no retest tasks were sampled in the window.
   */
  retestPassRate: z.number().nullable(),
  /** Cents, like every other money field; format with `usd()`/`money()`. */
  costCents: z.number(),
  /**
   * External retrieval, counted separately from model tokens. `priceCents` 0
   * means the deployment has not priced searches, so nothing is estimated.
   */
  search: z.object({
    requests: z.number(),
    priceCents: z.number(),
    estimatedCents: z.number(),
    /** Calls whose price was unknown when they ran — reported, not guessed. */
    unpricedRequests: z.number(),
  }),
  /**
   * Already a percentage (0–100), and an estimate — see the Review page.
   *
   * 只报活跃的**学习**目标：这一屏其余数字全是学习口径，把健康目标或
   * 者「随便一个活跃目标」的进度混进来，读起来是同一个人的同一周。
   * Null when no learning goal is active — 没有目标不是 0%。
   */
  goalProgress: z.number().nullable(),
  /**
   * Already a percentage (0–100), not a 0–1 ratio.
   * Null when no audit accept/reject events were sampled.
   */
  auditRejectRate: z.number().nullable(),
  sample: z.object({
    planned: z.number(),
    completed: z.number(),
    accepts: z.number(),
    rejects: z.number(),
    /**
     * 停在 needs_review 的审计条数：没有结论，因此既不进通过率的分母，
     * 也不进分子。单独报出来，否则"没判过"在复盘页上等于不存在。
     */
    pendingReview: z.number(),
  }),
});
export type WeeklyMetricsDto = z.infer<typeof weeklyMetricsSchema>;

export const todayPageSchema = z.object({
  user: userDtoSchema,
  profile: profileDtoSchema.nullable(),
  agents: z.array(agentDtoSchema),
  goals: z.array(goalDtoSchema),
  tasks: z.array(taskDtoSchema),
  approvals: z.array(approvalDtoSchema),
  council: councilDtoSchema.nullable(),
  checkin: checkinDtoSchema.nullable(),
  yesterdayCheckin: checkinDtoSchema.nullable(),
  brief: reviewDtoSchema.nullable(),
  weeklyMetrics: weeklyMetricsSchema,
  /**
   * The biggest line inside `weeklyMetrics.costCents`, derived from the same
   * budget ledger rows. Nullable because a week with no spend has nobody to
   * name — the card then renders no spender line at all.
   *
   * `cents` is not `.int()`: the ledger columns are `real`, so a fractional
   * cent is possible and a strict DTO would turn that row into a 500.
   */
  topSpender: z
    .object({
      agentId: z.string(),
      name: z.string(),
      cents: z.number().nonnegative(),
    })
    .nullable(),
  /** Derived counters the Today cards render as evidence, not hardcoded copy. */
  counts: z.object({
    agents: z.number(),
    pendingApprovals: z.number(),
    proposedInsights: z.number(),
  }),
});
export type TodayPageDto = z.infer<typeof todayPageSchema>;

/**
 * What the org has actually learned. Counts only — the artefacts themselves
 * live on /memory and /review, so a cabinet card never has to load them.
 */
export const knowledgeSchema = z.object({
  skills: z.object({ total: z.number(), certified: z.number() }),
  memories: z.object({ active: z.number(), conflicted: z.number() }),
  insights: z.object({ applied: z.number(), proposed: z.number() }),
  dissents: z.object({
    total: z.number(),
    vindicated: z.number(),
    pending: z.number(),
  }),
});
export type KnowledgeDto = z.infer<typeof knowledgeSchema>;

export const cabinetPageSchema = z.object({
  user: userDtoSchema,
  profile: profileDtoSchema.nullable(),
  agents: z.array(agentDtoSchema),
  tasks: z.array(taskDtoSchema),
  /** Keyed by agent id: the current week's ledger view for each card. */
  budgets: z.record(z.string(), budgetViewDtoSchema),
  knowledge: knowledgeSchema,
});
export type CabinetPageDto = z.infer<typeof cabinetPageSchema>;

/** One bucket of the audit-log filter chips. */
export const auditKindSchema = z.object({
  kind: z.string(),
  count: z.number(),
});

/**
 * The full hash-chained log. `kinds` always describes the whole log, not the
 * filtered slice, so the chips keep stable counts while paging.
 */
export const auditPageSchema = z.object({
  timezone: z.string(),
  events: z.array(auditEventDtoSchema),
  kinds: z.array(auditKindSchema),
  kind: z.string().nullable(),
  total: z.number(),
  filteredTotal: z.number(),
  offset: z.number(),
  limit: z.number(),
  hasMore: z.boolean(),
});
export type AuditPageDto = z.infer<typeof auditPageSchema>;

export const reviewPageSchema = z.object({
  user: userDtoSchema,
  profile: profileDtoSchema.nullable(),
  weekly: reviewDtoSchema.nullable(),
  insights: z.array(insightDtoSchema),
  agents: z.array(agentDtoSchema),
  tasks: z.array(taskDtoSchema),
  audit: z.array(auditEventDtoSchema),
  auditTotal: z.number(),
  dissents: z.array(dissentDtoSchema),
  insightTotal: z.number(),
  insightProposedTotal: z.number(),
  /** 整张表里已生效（applied）的洞察条数，不是 `insights` 这一页的。 */
  insightAppliedTotal: z.number(),
  /** 最新的几条已生效洞察，供「本周改了什么」展示；只有前几条，不代表全部。 */
  appliedInsights: z.array(insightDtoSchema),
  dissentTotal: z.number(),
  dissentPendingTotal: z.number(),
  insightOffset: z.number(),
  dissentOffset: z.number(),
  limit: z.number(),
  auditStats: z.record(
    z.string(),
    z.object({
      accepts: z.number(),
      total: z.number(),
      passRate: z.number(),
    }),
  ),
  /**
   * Per-Agent autonomy verdict computed by the command layer. The page renders
   * this object instead of recomputing thresholds from counters.
   */
  autonomyDecisions: z.record(
    z.string(),
    z.object({
      allowed: z.boolean(),
      level: z.number(),
      code: z.string().nullable(),
      reason: z.string(),
      samples: z.number(),
      passRate: z.number(),
    }),
  ),
  config: policyConfigDtoSchema,
  weeklyMetrics: weeklyMetricsSchema,
});
export type ReviewPageDto = z.infer<typeof reviewPageSchema>;

export const memoryPageSchema = z.object({
  timezone: z.string(),
  memories: z.array(memoryDtoSchema),
  counts: z.object({
    all: z.number(),
    episodic: z.number(),
    semantic: z.number(),
    procedural: z.number(),
  }),
  stale: z.number(),
  /**
   * Library-wide, like `counts` and `stale` — not a tally of the rows on
   * screen. Null when the view has no rows at all (no average to report).
   */
  conflicts: z.number(),
  avgConfidence: z.number().min(0).max(1).nullable(),
  total: z.number(),
  offset: z.number(),
  limit: z.number(),
  hasMore: z.boolean(),
});
export type MemoryPageDto = z.infer<typeof memoryPageSchema>;

export const councilPageSchema = z.object({
  timezone: z.string(),
  council: councilDtoSchema,
  positions: z.array(councilPositionDtoSchema),
  agents: z.array(agentDtoSchema),
});
export type CouncilPageDto = z.infer<typeof councilPageSchema>;

/** One mentor run the user may record as observed training evidence. */
export const observationCandidateSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  artifactId: z.string().nullable(),
  endedAt: z.string().nullable(),
});

/** Observation evidence for the apprentice detail surface. */
export const apprenticeshipEvidenceSchema = z.object({
  mentorId: z.string(),
  skillId: z.string(),
  skillVersion: z.number(),
  required: z.number(),
  observed: z.number(),
  candidates: z.array(observationCandidateSchema),
});
export type ApprenticeshipEvidenceDto = z.infer<
  typeof apprenticeshipEvidenceSchema
>;

export const agentPageSchema = z.object({
  timezone: z.string(),
  agent: agentDtoSchema,
  grants: z.array(grantDtoSchema),
  budget: budgetViewDtoSchema,
  apprenticeship: apprenticeshipEvidenceSchema.nullable(),
  runs: z.array(runDtoSchema),
  // Every memory this Agent has; the memories array above is only the window the card shows.
  memoryTotal: z.number().int().nonnegative(),
  memories: z.array(memoryDtoSchema),
  skills: z.array(skillDtoSchema),
  tasks: z.array(taskDtoSchema),
});
export type AgentPageDto = z.infer<typeof agentPageSchema>;

/** What the viewer may do, and the reason when they may not. */
export const taskActionStateSchema = z.object({
  allowed: z.boolean(),
  reason: z.string(),
});
export type TaskActionStateDto = z.infer<typeof taskActionStateSchema>;

export const taskPageSchema = z.object({
  timezone: z.string(),
  /** Computed by the server so a disabled button and the guard cannot disagree. */
  actions: z.object({
    run: taskActionStateSchema,
    audit: taskActionStateSchema,
    promote: taskActionStateSchema,
    cancel: taskActionStateSchema,
  }),
  task: taskDtoSchema,
  goal: goalDtoSchema.nullable(),
  assignee: agentDtoSchema.nullable(),
  auditor: agentDtoSchema.nullable(),
  runs: z.array(runDtoSchema),
  steps: z.array(stepDtoSchema),
  artifacts: z.array(artifactDtoSchema),
  evidence: z.array(retrievedEvidenceDtoSchema),
  approvals: z.array(approvalDtoSchema),
  audit: z.array(auditEventDtoSchema),
  /**
   * 最近一次人工判定；没有则是 null。单独取一条而不是从 audit 里筛：
   * 页面只拉最近 10 条审计行，而人判之后还可能追加其他审计事件，
   * 靠窗口筛会让"曾经判过"的记录随事件增多悄悄消失。
   */
  override: taskOverrideRecordSchema.nullable(),
});
export type TaskPageDto = z.infer<typeof taskPageSchema>;

/**
 * `GET /api/connectors` — what can this deployment actually reach?
 *
 * Reported as configuration state only: never a key, never a masked prefix.
 */
export const connectorStatusSchema = z.object({
  search: z.object({
    provider: z.string().nullable(),
    configured: z.boolean(),
    envVar: z.string().nullable(),
    fallback: z.string().nullable(),
    fallbackConfigured: z.boolean(),
  }),
  model: z.object({
    provider: z.string(),
    model: z.string(),
    configured: z.boolean(),
    envVar: z.string(),
  }),
  /** SMTP: host/port/from are not secrets; the password never appears here. */
  email: z.object({
    configured: z.boolean(),
    host: z.string().nullable(),
    port: z.number().nullable(),
    from: z.string().nullable(),
    secure: z.boolean(),
    envVars: z.array(z.string()),
  }),
  /** Weekly retrieval ceiling in cents; 0 means none was configured. */
  retrieval: z.object({
    budgetCents: z.number(),
  }),
  demoMode: z.boolean(),
});
export type ConnectorStatusDto = z.infer<typeof connectorStatusSchema>;

/** `POST /api/connectors/test` — one live attempt, reported honestly. */
export const connectorTestSchema = z.object({
  status: z.enum([
    "ok",
    "not_configured",
    "unauthorized",
    "rate_limited",
    "timeout",
    "invalid_response",
    "network_error",
  ]),
  provider: z.string().nullable(),
  latencyMs: z.number(),
  hits: z.number(),
  sample: z
    .object({ title: z.string(), url: z.string(), publisher: z.string().nullable() })
    .nullable(),
  message: z.string().nullable(),
});
export type ConnectorTestDto = z.infer<typeof connectorTestSchema>;

/** `GET /api/setup` — does this account already have a cabinet? */
export const workspaceStateSchema = z.object({
  hasWorkspace: z.boolean(),
});
export type WorkspaceStateDto = z.infer<typeof workspaceStateSchema>;

/** `GET /api/shell` — the sidebar's identity + autonomy ladder. */
export const shellContextSchema = z.object({
  name: z.string(),
  email: z.string(),
  agents: z.number(),
  /** How many on-duty agents have reached each rung. */
  autonomy: z.object({
    l1: z.number(),
    l2: z.number(),
    l3: z.number(),
  }),
});
export type ShellContextDto = z.infer<typeof shellContextSchema>;

/** `GET /api/audit/verify` — a verdict, not a failure: a broken chain is data. */
export const auditVerificationSchema = z.object({
  verified: z.boolean(),
  checked: z.number(),
  firstMismatch: z.string().nullable(),
});
export type AuditVerificationDto = z.infer<typeof auditVerificationSchema>;

/**
 * `GET /api/notifications` — the delivery log plus the preferences that shape
 * it. Statuses are the outbox states, not SMTP codes, so the page can explain
 * "skipped because you turned it off" as distinct from failure.
 */
export const deliveryItemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  subject: z.string(),
  body: z.string(),
  status: z.enum(["pending", "sending", "sent", "failed", "skipped"]),
  attempts: z.number(),
  lastError: z.string().nullable(),
  href: z.string().nullable(),
  targetType: z.string(),
  targetId: z.string(),
  nextAttemptAt: isoDateTime,
  sentAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type DeliveryItemDto = z.infer<typeof deliveryItemSchema>;

export const deliveryPageSchema = z.object({
  timezone: z.string(),
  prefs: z.object({
    notifyEnabled: z.boolean(),
    quietFrom: z.number(),
    quietTo: z.number(),
  }),
  email: z.object({
    configured: z.boolean(),
    host: z.string().nullable(),
    from: z.string().nullable(),
    envVars: z.array(z.string()),
  }),
  counts: z.object({
    pending: z.number(),
    /** Claimed by a runner that has not written back yet (may be stale). */
    sending: z.number(),
    sent: z.number(),
    failed: z.number(),
    skipped: z.number(),
  }),
  /** Lifetime rows; `items` is only the most recent page of them. */
  total: z.number(),
  /** Same paging metadata as the audit log, so both pages page the same way. */
  offset: z.number(),
  limit: z.number(),
  hasMore: z.boolean(),
  items: z.array(deliveryItemSchema),
});
export type DeliveryPageDto = z.infer<typeof deliveryPageSchema>;

export const notifyPrefsSchema = z.object({
  notifyEnabled: z.boolean(),
  quietFrom: z.number().int().min(0).max(23),
  quietTo: z.number().int().min(0).max(23),
});
export type NotifyPrefsDto = z.infer<typeof notifyPrefsSchema>;

/** `POST /api/notifications/run` — one manual delivery pass. */
export const deliveryRunSchema = z.object({
  sent: z.number(),
  failed: z.number(),
  skipped: z.number(),
  deferred: z.number(),
  /** Due but not attempted because SMTP is not configured. Still queued. */
  waiting: z.number(),
  claimed: z.number(),
  /** The lease was taken over mid-flight, so this result could not be written. */
  lost: z.number(),
});
export type DeliveryRunDto = z.infer<typeof deliveryRunSchema>;
