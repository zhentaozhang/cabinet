import { z } from "zod";

import {
  agentDtoSchema,
  approvalDtoSchema,
  artifactDtoSchema,
  auditEventDtoSchema,
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
  adherence: z.number(),
  managementMinutes: z.number(),
  managementMinutesSource: z.enum(["measured", "estimated"]),
  studyMinutes: z.number(),
  recallAvg: z.number().nullable(),
  learningTasks: z.number(),
  retestPassRate: z.number(),
  costUsd: z.number(),
  goalProgress: z.number(),
  auditRejectRate: z.number(),
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

export const cabinetPageSchema = z.object({
  user: userDtoSchema,
  profile: profileDtoSchema.nullable(),
  agents: z.array(agentDtoSchema),
  tasks: z.array(taskDtoSchema),
});
export type CabinetPageDto = z.infer<typeof cabinetPageSchema>;

export const reviewPageSchema = z.object({
  user: userDtoSchema,
  profile: profileDtoSchema.nullable(),
  weekly: reviewDtoSchema.nullable(),
  insights: z.array(insightDtoSchema),
  agents: z.array(agentDtoSchema),
  tasks: z.array(taskDtoSchema),
  audit: z.array(auditEventDtoSchema),
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

export const agentPageSchema = z.object({
  timezone: z.string(),
  agent: agentDtoSchema,
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
