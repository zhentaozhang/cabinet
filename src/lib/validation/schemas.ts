import { z } from "zod";
import { acceptanceItemSchema } from "@/contracts";

export const insightActionSchema = z.object({
  action: z.enum(["accept", "reject", "rollback"]),
});

export const autonomySchema = z.object({
  level: z.number().int().min(0).max(3),
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().max(2000).optional(),
});

export const councilDecisionSchema = z.object({
  decision: z.enum(["approve", "reject", "conditions"]),
  note: z.string().max(2000).default(""),
});

export const checkinSchema = z.object({
  energy: z.number().int().min(1).max(5).default(3),
  mood: z.number().int().min(1).max(5).default(3),
  completed: z
    .array(
      z.object({
        taskId: z.string().min(1),
        done: z.boolean(),
      }),
    )
    .default([]),
  note: z.string().max(2000).default(""),
});

export const taskCreateSchema = z
  .object({
    goalId: z.string().min(1).nullable().optional(),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(4000),
    assigneeId: z.string().min(1),
    auditorId: z.string().min(1),
    actionType: z
      .enum([
        "internal",
        "internal_read",
        "external",
        "spend",
        "publish",
        "message",
        "book",
      ])
      .default("internal"),
    resource: z.string().min(1).default("task"),
    estimatedCostCents: z.number().int().min(0).default(0),
    acceptanceCriteria: z.string().min(1).max(2000),
    acceptanceChecklist: z.array(acceptanceItemSchema).max(20).optional(),
    estimateMin: z.number().int().min(1).max(480).default(25),
    dueAt: z.string().min(1).nullable().optional(),
  })
  .refine((value) => value.assigneeId !== value.auditorId, {
    message: "Assignee and auditor must differ.",
  });

export const goalCreateSchema = z.object({
  title: z.string().min(1).max(200),
  why: z.string().min(1).max(1000),
  target: z.string().min(1).max(2000),
  horizon: z.string().min(1).max(100),
  domain: z.string().min(1).max(50).default("learning"),
});

export const councilCreateSchema = z.object({
  topic: z.string().min(1).max(300),
  trigger: z.string().min(1).max(300),
});

export const agentUpdateSchema = z
  .object({
    status: z.enum(["active", "paused", "retired"]).optional(),
    charter: z.string().min(20).max(4000).optional(),
    budgetCents: z.number().int().min(0).max(10_000_000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

export const setupSchema = z.object({
  timezone: z.string().min(1).max(100).default("Asia/Shanghai"),
  name: z.string().min(1).max(100).optional(),
  goal: z
    .object({
      title: z.string().min(1).max(200),
      why: z.string().max(1000).default(""),
      target: z.string().min(1).max(2000),
      horizon: z.string().min(1).max(100).default("6 weeks"),
      domain: z.string().min(1).max(50).default("learning"),
    })
    .optional(),
});
