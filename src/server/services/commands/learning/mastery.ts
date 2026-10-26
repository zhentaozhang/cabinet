import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { learningMastery, learningTopics } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { ConflictError } from "@/lib/domain/errors";
import type { Tx } from "@/server/services/shared/tx";
import {
  DEFAULT_TOPIC_KEY,
  INITIAL_EASE_FACTOR,
  masteryFrom,
  nextSchedule,
  normalizeTopicKey,
} from "@/lib/domain/mastery";

const DEFAULT_DUE_LIMIT = 5;
const MAX_DUE_LIMIT = 50;

function clampLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_DUE_LIMIT, Math.max(1, Math.floor(value)));
}

export type MasteryOutcome = {
  topicId: string;
  topicKey: string;
  label: string;
  attempts: number;
  correct: number;
  mastery: number;
  intervalDays: number;
  easeFactor: number;
  dueAt: Date | null;
};

/**
 * Record one reviewed answer for one topic.
 *
 * Three writes happen together: the topic is created on first contact, its
 * mastery row is created (or read), and the counters plus the SM-2 schedule
 * are written back. The write-back is conditional on the values that were
 * read, so two answers arriving at the same moment cannot both start from the
 * same `attempts` and silently drop one of them — the loser gets a
 * `ConflictError` and the caller retries against fresh numbers.
 *
 * `now` is only for replay and tests. Production leaves it out and the
 * schedule is stamped with the database's `now()`, because two app instances
 * with drifting clocks would otherwise disagree about when a topic is due.
 */
export async function recordOutcome(input: {
  userId: string;
  topicKey: string;
  label?: string;
  goalId?: string | null;
  correct: boolean;
  now?: Date;
  /**
   * 传进来就在调用方的事务（或其 savepoint）里写，否则自己开一个。
   *
   * 验收路径要的是"掌握度失败不拖垮验收"：在审计事务里再套一层 savepoint，
   * 掌握度写失败只回滚那一次写，审计与产物照常提交。反过来把这块留在事务外，
   * 一旦这里报错，验收已提交、掌握度却没发生，且没有任何东西会再算一遍。
   */
  tx?: Tx;
}): Promise<MasteryOutcome> {
  const key = normalizeTopicKey(input.topicKey);
  const rawLabel = (input.label ?? input.topicKey ?? "").trim();
  const label = rawLabel.length > 0 ? rawLabel : DEFAULT_TOPIC_KEY;
  const clock = input.now ?? null;

  const run = async (tx: Tx): Promise<MasteryOutcome> => {
    // The key is the identity; the label is how the topic was first written
    // down. Rewriting the label on every review would split one topic's
    // history across two display names, so the first spelling wins.
    await tx
      .insert(learningTopics)
      .values({
        id: newId("tpk"),
        userId: input.userId,
        goalId: input.goalId ?? null,
        key,
        label,
      })
      .onConflictDoNothing({
        target: [learningTopics.userId, learningTopics.key],
      });

    const [topic] = await tx
      .select()
      .from(learningTopics)
      .where(
        and(
          eq(learningTopics.userId, input.userId),
          eq(learningTopics.key, key),
        ),
      );
    if (!topic) {
      throw new ConflictError("学习主题写入冲突，请重试。");
    }

    const [existing] = await tx
      .select()
      .from(learningMastery)
      .where(
        and(
          eq(learningMastery.userId, input.userId),
          eq(learningMastery.topicId, topic.id),
        ),
      );

    let previous = existing;
    if (!previous) {
      // Another transaction may have created the row while this one waited on
      // the insert, so a conflict is not a failure: re-read and carry on from
      // its numbers instead of overwriting the other answer.
      await tx
        .insert(learningMastery)
        .values({
          id: newId("mst"),
          userId: input.userId,
          topicId: topic.id,
          attempts: 0,
          correct: 0,
          mastery: masteryFrom(0, 0),
          easeFactor: INITIAL_EASE_FACTOR,
          intervalDays: 0,
          dueAt: null,
        })
        .onConflictDoNothing({
          target: [learningMastery.userId, learningMastery.topicId],
        });

      const [created] = await tx
        .select()
        .from(learningMastery)
        .where(
          and(
            eq(learningMastery.userId, input.userId),
            eq(learningMastery.topicId, topic.id),
          ),
        );
      previous = created;
    }
    if (!previous) {
      throw new ConflictError("知识点掌握度写入冲突，请重试。");
    }

    const attempts = previous.attempts + 1;
    const correct = previous.correct + (input.correct ? 1 : 0);
    const schedule = nextSchedule({
      // Steps from the row as it was read: `attempts <= 0` means first
      // contact, which is what puts the first review one day out instead of
      // three.
      attempts: previous.attempts,
      intervalDays: previous.intervalDays,
      easeFactor: previous.easeFactor,
      correct: input.correct,
      // 生产路径的 dueAt 由 SQL 的 now() 计算（见下），这里的值只在调用方
      // 显式给了 now（回放/测试）时被使用。
      now: clock ?? new Date(0),
    });

    const stamp = clock ?? sql`now()`;
    const dueAt = clock
      ? schedule.dueAt
      : sql`now() + make_interval(days => ${schedule.intervalDays})`;

    const [updated] = await tx
      .update(learningMastery)
      .set({
        attempts,
        correct,
        mastery: masteryFrom(attempts, correct),
        easeFactor: schedule.easeFactor,
        intervalDays: schedule.intervalDays,
        dueAt,
        lastReviewedAt: stamp,
        updatedAt: stamp,
      })
      .where(
        and(
          eq(learningMastery.id, previous.id),
          eq(learningMastery.userId, input.userId),
          // Both counters are what this write derives from, so both are part of
          // the guard. `updated_at` is compared at millisecond precision
          // because a timestamptz round-trip drops the microseconds the column
          // stores, and comparing them raw would fail against its own value.
          eq(learningMastery.attempts, previous.attempts),
          eq(learningMastery.correct, previous.correct),
          // 参数先转成字符串再显式转型：drizzle 的裸 sql 模板不会替我们编码
          // Date，驱动会拿着 Date 对象按 timestamptz 的函数去序列化而报错。
          sql`date_trunc('milliseconds', ${learningMastery.updatedAt}) = date_trunc('milliseconds', ${
            previous.updatedAt.toISOString()
          }::timestamptz)`,
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictError("知识点掌握度已被并发修改，请重试。");
    }

    return {
      topicId: topic.id,
      topicKey: topic.key,
      label: topic.label,
      attempts: updated.attempts,
      correct: updated.correct,
      mastery: updated.mastery,
      intervalDays: updated.intervalDays,
      easeFactor: updated.easeFactor,
      dueAt: updated.dueAt,
    };
  };

  // 没有外部事务时才自己开：嵌套 db.transaction 会另起一个连接，看的是另一份
  // 快照，条件更新那一套就失效了。
  return input.tx ? run(input.tx) : db.transaction(run);
}

export type DueTopic = {
  topicKey: string;
  label: string;
  mastery: number;
  dueAt: Date | null;
  attempts: number;
};

/**
 * The topics the Coach should ask about next, most overdue first.
 *
 * A topic is due when its `dueAt` has passed — or when it has none at all.
 * NULL means "never scheduled", which is exactly the state a topic is in
 * before it is ever reviewed, so leaving it out would make a freshly created
 * topic unreachable. LEFT JOIN is what keeps that case visible; the COALESCEs
 * report an unpractised topic as mastery 0, attempts 0.
 */
export async function dueTopics(
  userId: string,
  options: { limit?: number; now?: Date } = {},
): Promise<DueTopic[]> {
  const limit = clampLimit(options.limit, DEFAULT_DUE_LIMIT);
  const dueFilter = options.now
    ? lte(learningMastery.dueAt, options.now)
    : sql`${learningMastery.dueAt} <= now()`;

  const rows = await db
    .select({
      topicKey: learningTopics.key,
      label: learningTopics.label,
      mastery: sql<number>`coalesce(${learningMastery.mastery}, 0)`,
      dueAt: learningMastery.dueAt,
      attempts: sql<number>`coalesce(${learningMastery.attempts}, 0)`,
    })
    .from(learningTopics)
    .leftJoin(
      learningMastery,
      and(
        eq(learningMastery.topicId, learningTopics.id),
        eq(learningMastery.userId, userId),
      ),
    )
    .where(
      and(
        eq(learningTopics.userId, userId),
        or(isNull(learningMastery.dueAt), dueFilter),
      ),
    )
    // The database decides "overdue first" (NULLS FIRST for the never-reviewed
    // ones); the key breaks ties so a page reload does not reshuffle the list.
    .orderBy(
      sql`${learningMastery.dueAt} asc nulls first`,
      asc(learningTopics.key),
    )
    .limit(limit);

  return rows.map((row) => ({
    topicKey: row.topicKey,
    label: row.label,
    mastery: Number(row.mastery),
    dueAt: row.dueAt,
    attempts: Number(row.attempts),
  }));
}

export type MasteryRow = {
  topicKey: string;
  label: string;
  attempts: number;
  correct: number;
  mastery: number;
  intervalDays: number;
  easeFactor: number;
  dueAt: Date | null;
  lastReviewedAt: Date | null;
};

/**
 * Everything the UI needs to show "how well do I know this, and when is it
 * coming back", weakest first.
 */
export async function listMastery(
  userId: string,
  options: { limit?: number } = {},
): Promise<MasteryRow[]> {
  const limit = clampLimit(options.limit, MAX_DUE_LIMIT);

  const rows = await db
    .select({
      topicKey: learningTopics.key,
      label: learningTopics.label,
      attempts: learningMastery.attempts,
      correct: learningMastery.correct,
      mastery: learningMastery.mastery,
      intervalDays: learningMastery.intervalDays,
      easeFactor: learningMastery.easeFactor,
      dueAt: learningMastery.dueAt,
      lastReviewedAt: learningMastery.lastReviewedAt,
    })
    .from(learningTopics)
    .innerJoin(
      learningMastery,
      and(
        eq(learningMastery.topicId, learningTopics.id),
        eq(learningMastery.userId, userId),
      ),
    )
    .where(eq(learningTopics.userId, userId))
    .orderBy(
      asc(learningMastery.mastery),
      sql`${learningMastery.dueAt} asc nulls first`,
    )
    .limit(limit);

  return rows;
}
