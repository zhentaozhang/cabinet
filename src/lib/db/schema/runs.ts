import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { tasks } from "./tasks";

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => tasks.id),
    agentId: text("agent_id").notNull().references(() => agents.id),
    status: text("status").notNull().default("queued"),
    mode: text("mode").notNull().default("demo"),
    sourceType: text("source_type").notNull().default("legacy_unknown"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // Telemetry only. The weekly budget ledger is the accounting authority.
    costCents: real("cost_cents").notNull().default(0),
    // Null means "usage unknown", which is not the same as a measured zero.
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    provider: text("provider"),
    model: text("model"),
    // One id per real provider call, unique across retries of the same task.
    providerAttemptId: text("provider_attempt_id"),
    costSource: text("cost_source"),
    error: text("error"),
    replayKey: text("replay_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("runs_task_idx").on(t.taskId),
    index("runs_task_created_idx").on(t.taskId, t.createdAt),
    index("runs_agent_idx").on(t.agentId),
    index("runs_provider_attempt_idx").on(t.providerAttemptId),
    check(
      "runs_cost_source_check",
      sql`${t.costSource} IS NULL OR ${t.costSource} IN ('actual', 'estimated', 'unknown')`,
    ),
  ],
);

export const steps = pgTable(
  "steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    idx: integer("idx").notNull(),
    type: text("type").notNull(),
    tool: text("tool"),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    output: jsonb("output").$type<Record<string, unknown>>().notNull(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("steps_run_idx").on(t.runId),
    uniqueIndex("steps_run_seq_idx").on(t.runId, t.idx),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").references(() => runs.id),
    taskId: text("task_id").notNull().references(() => tasks.id),
    type: text("type").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    submittedBy: text("submitted_by").notNull().default("agent"),
    sourceType: text("source_type").notNull().default("legacy_unknown"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("artifacts_task_idx").on(t.taskId, t.createdAt),
    index("artifacts_run_idx").on(t.runId),
    index("artifacts_task_source_idx").on(
      t.taskId,
      t.submittedBy,
      t.createdAt,
    ),
    check(
      "artifacts_submitted_by_check",
      sql`${t.submittedBy} IN ('agent', 'user')`,
    ),
  ],
);
