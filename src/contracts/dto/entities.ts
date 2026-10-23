import { z } from "zod";

import {
  evidenceSchema,
  insightChangeSchema,
  isoDateTime,
  jsonObject,
} from "./common";

/**
 * Entity DTOs: the serialisable projection of every table the UI reads.
 *
 * They are intentionally complete (same field set as the row) so that moving a
 * page from an in-process engine call to HTTP cannot silently drop a field the
 * page renders. Narrowing can happen later, per screen, with the type checker as
 * the guard.
 */

export const TASK_STATUSES = [
  "planned",
  "assigned",
  "awaiting_approval",
  "approved",
  "suggested",
  "running",
  "submitted",
  "auditing",
  "accepted",
  "rejected",
  "done",
  "failed",
  "cancelled",
] as const;

export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const userDtoSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  timezone: z.string(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type UserDto = z.infer<typeof userDtoSchema>;

export const profileDtoSchema = z.object({
  userId: z.string(),
  constraints: jsonObject,
  preferences: jsonObject,
  energyPattern: jsonObject,
  managementBudgetMin: z.number(),
  updatedAt: isoDateTime,
});
export type ProfileDto = z.infer<typeof profileDtoSchema>;

/**
 * A standing policy (a previous approval turned into a bounded rule) or a plain
 * permission grant. `state` is derived server-side so the UI never has to
 * re-implement expiry/exhaustion math.
 */
export const grantDtoSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  resource: z.string(),
  scope: z.string(),
  action: z.string(),
  label: z.string().nullable(),
  /** active | revoked | expired | exhausted | base */
  state: z.enum(["active", "revoked", "expired", "exhausted", "base"]),
  createdByApprovalId: z.string().nullable(),
  expiresAt: isoDateTime.nullable(),
  maxCents: z.number().nullable(),
  maxRuns: z.number().nullable(),
  useCount: z.number(),
  lastUsedAt: isoDateTime.nullable(),
  revokedAt: isoDateTime.nullable(),
  revokedReason: z.string().nullable(),
  createdAt: isoDateTime,
});
export type GrantDto = z.infer<typeof grantDtoSchema>;

export const agentDtoSchema = z.object({
  id: z.string(),
  userId: z.string(),
  role: z.string(),
  name: z.string(),
  title: z.string(),
  avatar: z.string(),
  charter: z.string(),
  objective: z.string(),
  model: z.string(),
  status: z.string(),
  autonomyLevel: z.number(),
  trustScore: z.number(),
  lifecycleStage: z.string(),
  mentorId: z.string().nullable(),
  tools: z.array(z.string()),
  memoryScope: z.array(z.string()),
  budgetCents: z.number(),
  spentCents: z.number(),
  budgetPeriodStart: isoDateTime.nullable(),
  policyJson: jsonObject.nullable(),
  successCount: z.number(),
  failCount: z.number(),
  rejectStreak: z.number(),
  createdAt: isoDateTime,
  retiredAt: isoDateTime.nullable(),
});
export type AgentDto = z.infer<typeof agentDtoSchema>;

export const goalDtoSchema = z.object({
  id: z.string(),
  userId: z.string(),
  domain: z.string(),
  title: z.string(),
  why: z.string(),
  target: z.string(),
  horizon: z.string(),
  status: z.string(),
  progress: z.number(),
  createdAt: isoDateTime,
});
export type GoalDto = z.infer<typeof goalDtoSchema>;

export const acceptanceItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("contains"),
    value: z.string(),
    required: z.boolean(),
  }),
  z.object({
    type: z.literal("min_words"),
    value: z.number(),
    required: z.boolean(),
  }),
  z.object({
    type: z.literal("min_sources"),
    value: z.number(),
    required: z.boolean(),
  }),
  z.object({
    type: z.literal("min_evidence"),
    value: z.number(),
    required: z.boolean(),
  }),
  z.object({
    type: z.literal("claims_table"),
    value: z.number(),
    required: z.boolean(),
  }),
  z.object({
    type: z.literal("section"),
    value: z.string(),
    required: z.boolean(),
  }),
  z.object({
    type: z.literal("manual"),
    note: z.string(),
    required: z.boolean(),
  }),
]);
export type AcceptanceItemDto = z.infer<typeof acceptanceItemSchema>;

export const acceptanceResultSchema = z.object({
  item: acceptanceItemSchema,
  passed: z.boolean(),
  reason: z.string(),
  undetermined: z.boolean().optional(),
});
export type AcceptanceResultDto = z.infer<typeof acceptanceResultSchema>;

export const taskDtoSchema = z.object({
  id: z.string(),
  userId: z.string(),
  goalId: z.string().nullable(),
  parentId: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  assigneeId: z.string().nullable(),
  auditorId: z.string().nullable(),
  status: taskStatusSchema,
  priority: z.number(),
  dueAt: isoDateTime.nullable(),
  acceptanceCriteria: z.string(),
  acceptanceChecklist: z.array(acceptanceItemSchema).nullable(),
  acceptanceReport: z.array(acceptanceResultSchema).nullable(),
  estimateMin: z.number(),
  actionType: z.string(),
  resource: z.string(),
  riskLevel: z.string(),
  requiresApproval: z.boolean(),
  approvalThresholdCents: z.number().nullable(),
  estimatedCostCents: z.number(),
  qualityGate: z.string().nullable(),
  template: z.string().nullable(),
  acceptedAt: isoDateTime.nullable(),
  acceptedAutonomyLevel: z.number().nullable(),
  createdBy: z.string(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type TaskDto = z.infer<typeof taskDtoSchema>;

export const runDtoSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  agentId: z.string(),
  status: z.string(),
  mode: z.string(),
  sourceType: z.string(),
  startedAt: isoDateTime.nullable(),
  endedAt: isoDateTime.nullable(),
  costCents: z.number(),
  // Null means usage unknown; a placeholder zero never stands in for it.
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  providerAttemptId: z.string().nullable(),
  costSource: z.string().nullable(),
  error: z.string().nullable(),
  replayKey: z.string().nullable(),
  createdAt: isoDateTime,
});
export type RunDto = z.infer<typeof runDtoSchema>;

/**
 * Weekly Agent budget as the ledger records it. The three amounts are separate
 * because they answer different questions: `reservedCents` is in-flight
 * pre-authorisation, `settledCents` is measured-token spend priced from the
 * configured rate, and `unknownCents` is exposure whose provider usage was
 * never reported. `legacyUnclassified` marks a week that already held runs
 * before the ledger existed — its spend is unknown, not zero.
 */
export const budgetViewDtoSchema = z.object({
  timezone: z.string(),
  periodStart: isoDateTime,
  periodEnd: isoDateTime,
  limitCents: z.number(),
  reservedCents: z.number(),
  settledCents: z.number(),
  unknownCents: z.number(),
  overrun: z.boolean(),
  legacyUnclassified: z.boolean(),
});
export type BudgetViewDto = z.infer<typeof budgetViewDtoSchema>;

export const stepDtoSchema = z.object({
  id: z.string(),
  runId: z.string(),
  idx: z.number(),
  type: z.string(),
  tool: z.string().nullable(),
  input: jsonObject,
  output: jsonObject,
  tokensIn: z.number(),
  tokensOut: z.number(),
  latencyMs: z.number(),
  createdAt: isoDateTime,
});
export type StepDto = z.infer<typeof stepDtoSchema>;

export const artifactDtoSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  taskId: z.string(),
  type: z.string(),
  title: z.string(),
  content: z.string(),
  submittedBy: z.string(),
  sourceType: z.string(),
  createdAt: isoDateTime,
});
export type ArtifactDto = z.infer<typeof artifactDtoSchema>;

/**
 * A retrieved source. `quote` is verbatim provider text and `retrievedAt` is
 * required: an undated, unquoted URL is not evidence.
 */
export const retrievedEvidenceDtoSchema = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  runId: z.string().nullable(),
  kind: z.string(),
  url: z.string(),
  title: z.string(),
  publisher: z.string().nullable(),
  quote: z.string(),
  provider: z.string(),
  retrievedAt: isoDateTime,
});
export type RetrievedEvidenceDto = z.infer<typeof retrievedEvidenceDtoSchema>;

export const memoryDtoSchema = z.object({
  id: z.string(),
  userId: z.string(),
  agentId: z.string().nullable(),
  type: z.string(),
  domain: z.string(),
  content: z.string(),
  factKey: z.string().nullable(),
  value: z.string().nullable(),
  validFrom: isoDateTime,
  validTo: isoDateTime.nullable(),
  supersededBy: z.string().nullable(),
  confidence: z.number(),
  salience: z.number(),
  evidence: z.array(evidenceSchema),
  sourceEventId: z.string().nullable(),
  lastConfirmedAt: isoDateTime.nullable(),
  expiresAt: isoDateTime.nullable(),
  status: z.string(),
  sourceType: z.string(),
  createdAt: isoDateTime,
});
export type MemoryDto = z.infer<typeof memoryDtoSchema>;

export const insightDtoSchema = z.object({
  id: z.string(),
  userId: z.string(),
  claim: z.string(),
  rationale: z.string(),
  confidence: z.number(),
  evidence: z.array(evidenceSchema),
  proposedChange: insightChangeSchema,
  beforeState: jsonObject.nullable(),
  afterState: jsonObject.nullable(),
  status: z.string(),
  createdAt: isoDateTime,
  decidedAt: isoDateTime.nullable(),
});
export type InsightDto = z.infer<typeof insightDtoSchema>;

export const reviewDtoSchema = z.object({
  id: z.string(),
  userId: z.string(),
  period: z.string(),
  type: z.string(),
  narrative: z.string(),
  metrics: z.record(z.string(), z.union([z.number(), z.string()])),
  decisions: z.array(jsonObject),
  createdAt: isoDateTime,
});
export type ReviewDto = z.infer<typeof reviewDtoSchema>;

export const approvalDtoSchema = z.object({
  id: z.string(),
  userId: z.string(),
  taskId: z.string().nullable(),
  runId: z.string().nullable(),
  action: z.string(),
  payload: jsonObject,
  status: z.string(),
  reason: z.string().nullable(),
  expiresAt: isoDateTime.nullable(),
  decidedAt: isoDateTime.nullable(),
  consumedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type ApprovalDto = z.infer<typeof approvalDtoSchema>;

export const auditEventDtoSchema = z.object({
  id: z.string(),
  seq: z.number(),
  userId: z.string(),
  actor: z.string(),
  action: z.string(),
  target: z.string(),
  before: jsonObject.nullable(),
  after: jsonObject.nullable(),
  hash: z.string(),
  prevHash: z.string().nullable(),
  createdAt: isoDateTime,
});
export type AuditEventDto = z.infer<typeof auditEventDtoSchema>;

export const skillDtoSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  name: z.string(),
  version: z.number(),
  steps: z.array(z.string()),
  tools: z.array(z.string()),
  status: z.string(),
  label: z.string(),
  evalSet: z.array(acceptanceItemSchema).nullable(),
  successCount: z.number(),
  failCount: z.number(),
  eval: jsonObject.nullable(),
  createdAt: isoDateTime,
});
export type SkillDto = z.infer<typeof skillDtoSchema>;

export const agentCardSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string(),
  name: z.string(),
  role: z.string(),
  title: z.string(),
  charter: z.string(),
  objective: z.string(),
  status: z.string(),
  lifecycleStage: z.string(),
  autonomyLevel: z.number(),
  trustScore: z.number(),
  successCount: z.number(),
  failCount: z.number(),
  tools: z.array(z.string()),
  skills: z.array(
    z.object({
      name: z.string(),
      version: z.number(),
      label: z.string(),
      status: z.string(),
      successCount: z.number(),
      failCount: z.number(),
    }),
  ),
  outcomes: z.array(
    z.object({
      taskId: z.string(),
      title: z.string(),
      status: z.string(),
      acceptedAt: isoDateTime.nullable(),
    }),
  ),
  generatedAt: isoDateTime,
});
export type AgentCardDto = z.infer<typeof agentCardSchema>;

export const councilScoreSchema = z.object({
  feasibility: z.number(),
  costEfficiency: z.number(),
  evidenceQuality: z.number(),
  robustness: z.number(),
});
export type CouncilScoreDto = z.infer<typeof councilScoreSchema>;

export const councilMatrixSchema = z.object({
  dimensions: councilScoreSchema,
  overall: z.number(),
  support: z.number(),
  oppose: z.number(),
  neutral: z.number(),
  consensus: z.enum(["support", "oppose", "split"]),
  dissentAgentIds: z.array(z.string()),
});
export type CouncilMatrixDto = z.infer<typeof councilMatrixSchema>;

export const falsificationConditionSchema = z.object({
  metric: z.enum([
    "audit_reject_count",
    "budget_spend_cents",
    "task_failure_count",
    "agent_paused",
  ]),
  operator: z.enum([">=", ">", "=="]),
  threshold: z.number(),
  windowDays: z.number(),
});
export type FalsificationConditionDto = z.infer<
  typeof falsificationConditionSchema
>;

export const dissentDtoSchema = z.object({
  id: z.string(),
  userId: z.string(),
  councilId: z.string(),
  taskId: z.string().nullable(),
  agentId: z.string(),
  warning: z.string(),
  condition: falsificationConditionSchema,
  status: z.string(),
  evidence: z.array(evidenceSchema),
  evaluatedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type DissentDto = z.infer<typeof dissentDtoSchema>;

export const councilResolutionSchema = z.object({
  decision: z.enum(["approve", "reject", "conditions"]),
  note: z.string(),
  taskId: z.string().nullable(),
  memoryId: z.string().nullable(),
  dissents: z.array(
    z.object({
      agentId: z.string(),
      claim: z.string(),
      risk: z.string(),
      recommendation: z.string(),
    }),
  ),
  decidedAt: isoDateTime,
});
export type CouncilResolutionDto = z.infer<typeof councilResolutionSchema>;

export const councilDtoSchema = z.object({
  id: z.string(),
  userId: z.string(),
  topic: z.string(),
  trigger: z.string(),
  status: z.string(),
  memo: z.string(),
  matrix: councilMatrixSchema.nullable(),
  resolution: councilResolutionSchema.nullable(),
  resolutionAppliedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  decidedAt: isoDateTime.nullable(),
});
export type CouncilDto = z.infer<typeof councilDtoSchema>;

export const councilPositionDtoSchema = z.object({
  id: z.string(),
  councilId: z.string(),
  agentId: z.string(),
  stance: z.string(),
  claim: z.string(),
  evidence: z.array(evidenceSchema),
  risk: z.string(),
  recommendation: z.string(),
  scores: councilScoreSchema.nullable(),
  isDissent: z.boolean(),
  falsificationCondition: falsificationConditionSchema.nullable(),
  createdAt: isoDateTime,
});
export type CouncilPositionDto = z.infer<typeof councilPositionDtoSchema>;

export const checkinDtoSchema = z.object({
  id: z.string(),
  userId: z.string(),
  /** `checkins.date` is a calendar key (YYYY-MM-DD), not a timestamp. */
  date: z.string(),
  energy: z.number(),
  mood: z.number(),
  completed: z.array(z.object({ taskId: z.string(), done: z.boolean() })),
  note: z.string(),
  studyMinutes: z.number(),
  recallScore: z.number().nullable(),
  errorTags: z.array(z.string()),
  createdAt: isoDateTime,
});
export type CheckinDto = z.infer<typeof checkinDtoSchema>;

export const policyConfigDtoSchema = z.object({
  autonomy: z.object({
    minTrust: z.number(),
    minSuccesses: z.number(),
    minAuditPassRate: z.number(),
    minAuditSamples: z.number(),
  }),
  audit: z.object({
    rejectStreakLimit: z.number(),
    passRateWindow: z.number(),
  }),
  budget: z.object({
    weeklyLimitCents: z.number(),
    approvalThresholdCents: z.number(),
  }),
  management: z.object({ minutesPerDecision: z.number() }),
  cost: z.object({
    perMinuteCents: z.number(),
    centsPer1kTokens: z.number(),
  }),
});
export type PolicyConfigDto = z.infer<typeof policyConfigDtoSchema>;
