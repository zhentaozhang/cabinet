import { z } from "zod";

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
  goalDtoSchema,
  insightDtoSchema,
  memoryDtoSchema,
  policyConfigDtoSchema,
  profileDtoSchema,
  reviewDtoSchema,
  runDtoSchema,
  skillDtoSchema,
  stepDtoSchema,
  taskDtoSchema,
  userDtoSchema,
} from "./entities";

/**
 * Page-shaped read models.
 *
 * One endpoint per screen aggregate — never one per table — so the frontend
 * keeps a single round trip per page after the split, exactly like it has today
 * with in-process engine calls.
 */

export const weeklyMetricsSchema = z.object({
  weekKey: z.string(),
  aao: z.number(),
  /** Null when no tasks were planned in the window. */
  adherence: z.number().nullable(),
  /** Null when there are neither measured actions nor decision samples. */
  managementMinutes: z.number().nullable(),
  managementMinutesSource: z.enum(["measured", "estimated"]),
  studyMinutes: z.number(),
  recallAvg: z.number().nullable(),
  learningTasks: z.number(),
  /** Null when no retest tasks were sampled in the window. */
  retestPassRate: z.number().nullable(),
  costUsd: z.number(),
  goalProgress: z.number(),
  /** Null when no audit accept/reject events were sampled. */
  auditRejectRate: z.number().nullable(),
  sample: z.object({
    planned: z.number(),
    completed: z.number(),
    accepts: z.number(),
    rejects: z.number(),
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
  budget: budgetViewDtoSchema,
  apprenticeship: apprenticeshipEvidenceSchema.nullable(),
  runs: z.array(runDtoSchema),
  memories: z.array(memoryDtoSchema),
  skills: z.array(skillDtoSchema),
  tasks: z.array(taskDtoSchema),
});
export type AgentPageDto = z.infer<typeof agentPageSchema>;

export const taskPageSchema = z.object({
  timezone: z.string(),
  task: taskDtoSchema,
  goal: goalDtoSchema.nullable(),
  assignee: agentDtoSchema.nullable(),
  auditor: agentDtoSchema.nullable(),
  runs: z.array(runDtoSchema),
  steps: z.array(stepDtoSchema),
  artifacts: z.array(artifactDtoSchema),
  approvals: z.array(approvalDtoSchema),
  audit: z.array(auditEventDtoSchema),
});
export type TaskPageDto = z.infer<typeof taskPageSchema>;

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
