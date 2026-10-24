import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./core";
import { tasks } from "./tasks";

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    key: text("key").notNull(),
    endpoint: text("endpoint").notNull(),
    requestHash: text("request_hash").notNull(),
    responseJson: jsonb("response_json").$type<Record<string, unknown>>(),
    statusCode: integer("status_code").notNull().default(200),
    status: text("status").notNull().default("completed"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("idempotency_user_key_idx").on(t.userId, t.key)],
);

export const userActions = pgTable(
  "user_actions",
  {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  action: text("action").notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  },
  (t) => [index("user_actions_user_created_idx").on(t.userId, t.createdAt)],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    action: text("action").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    uniqueIndex("rate_limit_unique_idx").on(
      t.userId,
      t.action,
      t.windowStart,
    ),
  ],
);

/**
 * Outbox, not direct sending: a request must never block on an SMTP handshake,
 * and a delivery that fails must survive a process restart. Rows are claimed by
 * status transition, sent by a separate runner, and never deleted.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** rejection | approval | budget | conflict | council */
    kind: text("kind").notNull(),
    /** One row per event per day: the same rejection must not mail twice. */
    dedupeKey: text("dedupe_key").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    /** In-app path the mail links to, so the message is actionable. */
    href: text("href"),
    /** pending | sent | failed | skipped */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /**
     * Set when a runner claims the row. Every write-back must present the same
     * token, so a runner whose lease was taken over cannot overwrite the newer
     * result (or claim a send it did not finish).
     */
    claimToken: text("claim_token"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("outbox_user_dedupe_idx").on(t.userId, t.dedupeKey),
    index("outbox_due_idx").on(t.status, t.nextAttemptAt),
    index("outbox_user_created_idx").on(t.userId, t.createdAt),
  ],
);

export type OutboxRow = typeof outbox.$inferSelect;

/**
 * A durable run request.
 *
 * The API used to execute a run inside the POST that asked for it, so a restart
 * mid-run left a `running` run and a held budget reservation that nothing would
 * ever release. A job survives the process: a worker claims it with a lease,
 * and whatever is still claimed after the lease expires gets recovered by the
 * one pass that knows the run may already have reached a paid provider.
 */
export const runJobs = pgTable(
  "run_jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** queued | running | succeeded | blocked | failed */
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    /** Holder of the lease; every write-back must present the same token. */
    claimToken: text("claim_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    /** The run this job produced, once it got that far. */
    runId: text("run_id"),
    lastError: text("last_error"),
    requestedBy: text("requested_by").notNull().default("user"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("run_jobs_claim_idx").on(t.status, t.createdAt),
    index("run_jobs_user_created_idx").on(t.userId, t.createdAt),
    index("run_jobs_task_idx").on(t.taskId),
    // At most one live job per task. A finished job leaves the slot free, so a
    // task can always be queued again; only the select-then-insert race that
    // produced two workers for one task is excluded.
    uniqueIndex("run_jobs_active_task_idx")
      .on(t.taskId)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

export type RunJobRow = typeof runJobs.$inferSelect;
