import { z } from "zod";
import { acceptanceItemSchema } from "@/contracts";

export const insightActionSchema = z.object({
  action: z.enum(["accept", "reject", "rollback"]),
});

export const apprenticeObservationSchema = z.object({
  runId: z.string().min(1),
});

export const autonomySchema = z.object({
  level: z.number().int().min(0).max(3),
});

export const rememberSchema = z.object({
  days: z.number().int().min(1).max(180),
  maxCents: z.number().int().min(0).optional(),
  maxRuns: z.number().int().min(1).max(200).optional(),
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().max(2000).optional(),
  /**
   * "以后同类自动执行". Only honoured on approve; a rejection never mints
   * standing authority, so the field is ignored there rather than rejected —
   * the decision is still valid without it.
   */
  remember: rememberSchema.optional(),
});

export const councilDecisionSchema = z
  .object({
    decision: z.enum(["approve", "reject", "conditions"]),
    note: z.string().max(2000).default(""),
  })
  .refine((value) => value.decision !== "reject" || value.note.trim().length > 0, {
    message: "Rejecting a council decision requires a reason.",
    path: ["note"],
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
  studyMinutes: z.number().int().min(0).max(1440).default(0),
  recallScore: z.number().min(0).max(1).nullable().optional(),
  errorTags: z.array(z.string().min(1).max(40)).max(10).default([]),
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
  })
  .refine(
    (value) =>
      value.actionType !== "spend" || value.estimatedCostCents > 0,
    {
      message: "Spend tasks require a positive estimated cost.",
      path: ["estimatedCostCents"],
    },
  );

export const taskSubmitSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(20000),
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
  goal: z.object({
    title: z.string().min(1).max(200),
    why: z.string().max(1000).default(""),
    target: z.string().min(1).max(2000),
    horizon: z.string().min(1).max(100).default("6 weeks"),
    domain: z.string().min(1).max(50).default("learning"),
  }),
});
