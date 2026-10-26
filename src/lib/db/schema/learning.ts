import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { JudgeVerdict } from "./types";
import { users } from "./core";
import { goals } from "./goals";
import { tasks } from "./tasks";
import { artifacts } from "./runs";

/**
 * The learning domain's own tables.
 *
 * Until now the learning loop stored everything it knew inside `checkins`
 * (one recall score, a free-text `error_tags` array) and `tasks`
 * (`error_tags.0` became the topic). That is enough to pick *a* topic, but it
 * cannot answer "how well does this person know closures", and it cannot
 * schedule anything: a single global recall number has no per-topic history to
 * space repetitions from.
 *
 * These three tables add the missing dimension without touching the existing
 * ones: topics give tags an identity, mastery keeps per-topic history and the
 * next review date, attempts keep the answer plus the verdict that produced it.
 */

export const learningTopics = pgTable(
  "learning_topics",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    goalId: text("goal_id").references(() => goals.id),
    /** Normalised lookup key (`closure`, `事件循环`); `label` keeps the casing. */
    key: text("key").notNull(),
    label: text("label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("learning_topics_user_key_idx").on(t.userId, t.key),
    index("learning_topics_goal_idx").on(t.goalId),
    check("learning_topics_key_not_blank", sql`btrim(${t.key}) <> ''`),
  ],
);

/**
 * One row per (user, topic). `mastery` is a 0..1 estimate derived from the
 * attempt history — it is *not* the source of truth, `correct`/`attempts` is.
 * The scheduling columns follow SM-2: `easeFactor` grows on success and shrinks
 * on failure, `intervalDays` is the current gap, `dueAt` is when the topic
 * should be asked again.
 *
 * A row is created on first contact with a topic and never deleted, so the
 * history survives a goal being archived.
 */
export const learningMastery = pgTable(
  "learning_mastery",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    topicId: text("topic_id")
      .notNull()
      .references(() => learningTopics.id),
    attempts: integer("attempts").notNull().default(0),
    correct: integer("correct").notNull().default(0),
    mastery: real("mastery").notNull().default(0),
    easeFactor: real("ease_factor").notNull().default(2.5),
    intervalDays: integer("interval_days").notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true }),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("learning_mastery_user_topic_idx").on(t.userId, t.topicId),
    index("learning_mastery_user_due_idx").on(t.userId, t.dueAt),
    check("learning_mastery_attempts_non_negative", sql`${t.attempts} >= 0`),
    check(
      "learning_mastery_correct_within_attempts",
      sql`${t.correct} >= 0 AND ${t.correct} <= ${t.attempts}`,
    ),
    check(
      "learning_mastery_mastery_range",
      sql`${t.mastery} >= 0 AND ${t.mastery} <= 1`,
    ),
    // 1.3 must be written as `1.3::real`: the column is float4, where 1.3
    // stores as 1.29999995, and comparing it against the numeric literal 1.3
    // (widened to float8) rejects the very value the floor is meant to allow.
    check(
      "learning_mastery_ease_floor",
      sql`${t.easeFactor} >= 1.3::real`,
    ),
    check(
      "learning_mastery_interval_non_negative",
      sql`${t.intervalDays} >= 0`,
    ),
  ],
);

/**
 * The answer as it was judged, so a verdict can be re-read later without
 * re-running the model. `rubric` is a snapshot of the criteria the judge was
 * given: editing a task's checklist afterwards must not rewrite history.
 *
 * `judgedBy` records what actually decided it:
 *   - `rule`   — deterministic checks only (offline path)
 *   - `model`  — the LLM judge ran and its verdicts are in `verdicts`
 *   - `human`  — a person judged it
 * A `model` row whose verdicts are all undetermined is still `model`: the
 * caller decides what to do with an undecidable item.
 */
export const learningAttempts = pgTable(
  "learning_attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    artifactId: text("artifact_id").references(() => artifacts.id),
    topicId: text("topic_id").references(() => learningTopics.id),
    prompt: text("prompt").notNull(),
    answer: text("answer").notNull(),
    rubric: jsonb("rubric").$type<string[]>().notNull().default([]),
    verdicts: jsonb("verdicts").$type<JudgeVerdict[]>(),
    score: real("score"),
    judgedBy: text("judged_by").notNull().default("rule"),
    judgeModel: text("judge_model"),
    accepted: boolean("accepted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One submission is one attempt. Re-auditing the same task updates the row
    // instead of stacking duplicates and double-counting mastery.
    uniqueIndex("learning_attempts_user_task_idx").on(t.userId, t.taskId),
    index("learning_attempts_user_created_idx").on(t.userId, t.createdAt),
    index("learning_attempts_topic_idx").on(t.topicId),
    check("learning_attempts_judged_by_check", sql`${t.judgedBy} IN ('rule', 'model', 'human')`),
    check(
      "learning_attempts_score_range",
      sql`${t.score} IS NULL OR (${t.score} >= 0 AND ${t.score} <= 1)`,
    ),
    check(
      "learning_attempts_rubric_is_array",
      sql`jsonb_typeof(${t.rubric}) = 'array'`,
    ),
    // 判卷结论同样只接受数组：一个对象或字符串会让下游的逐条渲染崩掉，
    // 而那行数据看起来"有内容"，排查时最难定位。
    check(
      "learning_attempts_verdicts_is_array",
      sql`${t.verdicts} IS NULL OR jsonb_typeof(${t.verdicts}) = 'array'`,
    ),
  ],
);
