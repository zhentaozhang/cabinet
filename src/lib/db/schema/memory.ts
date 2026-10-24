import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { Evidence, Metrics, ProposedChange } from "./types";
import { users } from "./core";
import { agents, skills } from "./agents";
import { tasks } from "./tasks";
import { artifacts, runs } from "./runs";

export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    agentId: text("agent_id").references(() => agents.id),
    type: text("type").notNull(),
    domain: text("domain").notNull(),
    content: text("content").notNull(),
    /** Stable key for a fact that can be superseded, e.g. schedule:tsk_1. */
    factKey: text("fact_key"),
    /** The fact's value at this point on the timeline. */
    value: text("value"),
    validFrom: timestamp("valid_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    supersededBy: text("superseded_by"),
    confidence: real("confidence").notNull().default(0.5),
    salience: real("salience").notNull().default(0.5),
    evidence: jsonb("evidence").$type<Evidence[]>().notNull(),
    sourceEventId: text("source_event_id"),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status").notNull().default("active"),
    sourceType: text("source_type").notNull().default("legacy_unknown"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("memories_user_idx").on(t.userId),
    index("memories_fact_idx").on(t.userId, t.factKey),
    uniqueIndex("memories_fact_active_unique")
      .on(t.userId, t.factKey)
      .where(sql`${t.validTo} IS NULL`),
  ],
);

export const insights = pgTable(
  "insights",
  {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  claim: text("claim").notNull(),
  rationale: text("rationale").notNull(),
  confidence: real("confidence").notNull().default(0.5),
  evidence: jsonb("evidence").$type<Evidence[]>().notNull(),
  proposedChange: jsonb("proposed_change")
    .$type<ProposedChange>()
    .notNull(),
  beforeState: jsonb("before_state").$type<Record<string, unknown> | null>(),
  afterState: jsonb("after_state").$type<Record<string, unknown> | null>(),
  status: text("status").notNull().default("proposed"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
},
  (t) => [
    index("insights_user_status_idx").on(t.userId, t.status),
    index("insights_user_created_idx").on(t.userId, t.createdAt),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  period: text("period").notNull(),
  type: text("type").notNull(),
  narrative: text("narrative").notNull(),
  metrics: jsonb("metrics").$type<Metrics>().notNull(),
  decisions: jsonb("decisions")
    .$type<Array<Record<string, unknown>>>()
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
},
  (t) => [
    index("reviews_user_type_idx").on(t.userId, t.type, t.createdAt),
    uniqueIndex("reviews_user_type_period_unique").on(
      t.userId,
      t.type,
      t.period,
    ),
  ],
);

/**
 * Explicit training evidence: the user recorded that the apprentice watched one
 * specific mentor run. Nothing is inferred from historical runs, and demo, rule
 * or legacy rows can never be attested, so the exam gate counts real practice.
 */
export const apprenticeObservations = pgTable(
  "apprentice_observations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    apprenticeId: text("apprentice_id")
      .notNull()
      .references(() => agents.id),
    mentorId: text("mentor_id")
      .notNull()
      .references(() => agents.id),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    skillVersion: integer("skill_version").notNull(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    artifactId: text("artifact_id").references(() => artifacts.id),
    attestedByUserId: text("attested_by_user_id")
      .notNull()
      .references(() => users.id),
    attestedAt: timestamp("attested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    qualification: text("qualification").notNull().default("qualified"),
    reason: text("reason"),
  },
  (t) => [
    // One recording per (apprentice, skill version, mentor run): re-recording a
    // retried run can never inflate the evidence count.
    uniqueIndex("apprentice_observations_key").on(
      t.apprenticeId,
      t.skillId,
      t.skillVersion,
      t.runId,
    ),
    index("apprentice_observations_user_idx").on(t.userId),
    check(
      "apprentice_observations_qualification_check",
      sql`${t.qualification} IN ('qualified', 'disqualified')`,
    ),
  ],
);

/**
 * The evidence each exam attempt was graded against. Snapshots are immutable,
 * so retries reuse the same observations instead of consuming them, and an
 * auditor can always see which runs a pass was based on.
 */
export const apprenticeExamSnapshots = pgTable(
  "apprentice_exam_snapshots",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    apprenticeId: text("apprentice_id")
      .notNull()
      .references(() => agents.id),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    skillVersion: integer("skill_version").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    runId: text("run_id").references(() => runs.id),
    observationIds: jsonb("observation_ids").$type<string[]>().notNull().default([]),
    passed: boolean("passed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("apprentice_exam_snapshots_key").on(
      t.apprenticeId,
      t.skillId,
      t.skillVersion,
      t.attemptNo,
    ),
    index("apprentice_exam_snapshots_run_idx").on(t.runId),
  ],
);
