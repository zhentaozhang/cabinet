import { sql } from "drizzle-orm";
import { bigserial, boolean, check, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./core";
import { agents } from "./agents";
import { tasks } from "./tasks";
import { runs } from "./runs";

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    userId: text("user_id").notNull().references(() => users.id),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    hash: text("hash").notNull(),
    prevHash: text("prev_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_user_idx").on(t.userId),
    index("audit_user_created_idx").on(t.userId, t.createdAt),
    index("audit_user_target_idx").on(t.userId, t.target),
    uniqueIndex("audit_seq_idx").on(t.seq),
  ],
);

export const policyConfig = pgTable("policy_config", {
  key: text("key").primaryKey(),
  valueJson: jsonb("value_json").$type<unknown>().notNull(),
  description: text("description").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Weekly budget ledger, one row per (Agent, user-local week).
 *
 * This table, not `runs.cost_cents` and not the legacy `agents.spent_cents`
 * columns, is the accounting authority for budget admission. `limitCents` is a
 * snapshot taken when the row is created so later policy edits do not rewrite
 * already-observed history.
 */
export const agentBudgetPeriods = pgTable(
  "agent_budget_periods",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    // The timezone that defines the local week boundaries of this period.
    timezone: text("timezone").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    limitCents: real("limit_cents").notNull(),
    reservedCents: real("reserved_cents").notNull().default(0),
    settledCents: real("settled_cents").notNull().default(0),
    unknownCents: real("unknown_cents").notNull().default(0),
    overrun: boolean("overrun").notNull().default(false),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_budget_periods_key").on(t.agentId, t.periodStart),
    check("agent_budget_periods_limit_check", sql`${t.limitCents} >= 0`),
    check("agent_budget_periods_reserved_check", sql`${t.reservedCents} >= 0`),
    check("agent_budget_periods_settled_check", sql`${t.settledCents} >= 0`),
    check("agent_budget_periods_unknown_check", sql`${t.unknownCents} >= 0`),
  ],
);

/**
 * One row per provider attempt that holds budget. `state = "reserved"` means
 * the allowance is still held; settlement moves it to `settled`, `released`,
 * or `unknown_charged`. The unique key is the run id (partial index, since a
 * hold may exist before its run row does).
 */
export const agentBudgetReservations = pgTable(
  "agent_budget_reservations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    periodId: text("period_id")
      .notNull()
      .references(() => agentBudgetPeriods.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    taskId: text("task_id").references(() => tasks.id),
    runId: text("run_id").references(() => runs.id),
    state: text("state").notNull().default("reserved"),
    amountCents: real("amount_cents").notNull(),
    settledCents: real("settled_cents").notNull().default(0),
    providerAttemptId: text("provider_attempt_id"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    // Partial unique index (`WHERE run_id IS NOT NULL`) is added in the
    // migration SQL; Drizzle's builder cannot express the predicate.
    index("agent_budget_reservations_period_idx").on(t.periodId),
    index("agent_budget_reservations_run_idx").on(t.runId),
    check(
      "agent_budget_reservations_state_check",
      sql`${t.state} IN ('reserved', 'settled', 'released', 'unknown_charged')`,
    ),
    check("agent_budget_reservations_amount_check", sql`${t.amountCents} >= 0`),
  ],
);

/**
 * One row per externally retrieved source. Evidence is the only thing the
 * Auditor may count as a citation: prose that merely contains a URL proves
 * nothing, so `quote` is required and the row records who fetched it and when.
 */
export const evidence = pgTable(
  "evidence",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    taskId: text("task_id").references(() => tasks.id),
    runId: text("run_id").references(() => runs.id),
    kind: text("kind").notNull().default("web_page"),
    url: text("url").notNull(),
    title: text("title").notNull(),
    publisher: text("publisher"),
    /** Verbatim snippet from the provider; never generated by us. */
    quote: text("quote").notNull(),
    /** Provider that returned it, so a result stays attributable. */
    provider: text("provider").notNull(),
    contentHash: text("content_hash").notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("evidence_task_idx").on(t.taskId, t.createdAt),
    index("evidence_run_idx").on(t.runId),
    index("evidence_user_idx").on(t.userId),
  ],
);

export type EvidenceRow = typeof evidence.$inferSelect;

/**
 * One row per outbound retrieval call, whatever it returned.
 *
 * `evidence` records what was worth citing; a call that found nothing still
 * cost money, so billing needs its own ledger. `unitPriceCents` is the price in
 * force at the moment of the call, which keeps last month's report from being
 * silently re-priced when the operator edits SEARCH_COST_CENTS_PER_REQUEST.
 */
export const retrievalCalls = pgTable(
  "retrieval_calls",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    taskId: text("task_id").references(() => tasks.id),
    runId: text("run_id").references(() => runs.id),
    /** The tool the plan ran: web_search or web_fetch. */
    tool: text("tool").notNull(),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    hits: integer("hits").notNull().default(0),
    unitPriceCents: integer("unit_price_cents").notNull().default(0),
    chargedCents: integer("charged_cents").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("retrieval_calls_user_created_idx").on(t.userId, t.createdAt)],
);

export type RetrievalCallRow = typeof retrievalCalls.$inferSelect;
