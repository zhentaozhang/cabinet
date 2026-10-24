import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { AcceptanceItem, AcceptanceResult } from "./types";
import { users } from "./core";
import { agents } from "./agents";
import { goals } from "./goals";

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    goalId: text("goal_id").references(() => goals.id),
    parentId: text("parent_id"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    assigneeId: text("assignee_id").references(() => agents.id),
    auditorId: text("auditor_id").references(() => agents.id),
    status: text("status").notNull().default("planned"),
    priority: integer("priority").notNull().default(2),
    dueAt: timestamp("due_at", { withTimezone: true }),
    acceptanceCriteria: text("acceptance_criteria").notNull(),
    acceptanceChecklist: jsonb("acceptance_checklist")
      .$type<AcceptanceItem[]>(),
    acceptanceReport: jsonb("acceptance_report")
      .$type<AcceptanceResult[]>(),
    estimateMin: integer("estimate_min").notNull().default(25),
    actionType: text("action_type").notNull().default("internal"),
    resource: text("resource").notNull().default("task"),
    riskLevel: text("risk_level").notNull().default("low"),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    approvalThresholdCents: integer("approval_threshold_cents"),
    estimatedCostCents: integer("estimated_cost_cents").notNull().default(0),
    qualityGate: text("quality_gate"),
    template: text("template"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedAutonomyLevel: integer("accepted_autonomy_level"),
    createdBy: text("created_by").notNull().default("agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("tasks_status_idx").on(t.status),
    index("tasks_assignee_idx").on(t.assigneeId),
    index("tasks_user_status_idx").on(t.userId, t.status),
    index("tasks_user_due_idx").on(t.userId, t.dueAt),
    index("tasks_user_updated_idx").on(t.userId, t.updatedAt),
    index("tasks_user_accepted_idx").on(t.userId, t.acceptedAt),
    check(
      "tasks_assignee_not_auditor",
      sql`${t.assigneeId} IS NULL OR ${t.auditorId} IS NULL OR ${t.assigneeId} <> ${t.auditorId}`,
    ),
    check(
      "tasks_cost_non_negative",
      sql`${t.estimatedCostCents} >= 0`,
    ),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  taskId: text("task_id").references(() => tasks.id),
  runId: text("run_id"),
  action: text("action").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("pending"),
  reason: text("reason"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
},
  (t) => [
    index("approvals_user_status_idx").on(t.userId, t.status),
    index("approvals_task_idx").on(t.taskId),
  ],
);
