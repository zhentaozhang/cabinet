import { and, desc, eq, gte, inArray, isNotNull, lt, ne } from "drizzle-orm";
import type { Tx } from "../shared/tx";
import { checkins, goals, tasks, users } from "@/lib/db/schema";
import { localDateKey, weekRange } from "@/lib/domain/time";
import { computeLearningProgress } from "@/lib/domain/learning-progress";
import type { LearningConfig } from "@/lib/domain/policy";

// 学习模板清单只有一份：多一处副本，加第三种模板时就会有一处悄悄不认它。
export { LEARNING_TEMPLATES } from "@/lib/domain/learning";
import { LEARNING_TEMPLATES } from "@/lib/domain/learning";

/**
 * The only goal domain the formula below can score.
 *
 * `goals.domain` is free text（seed 里有 learning / health / calendar / council），
 * and this formula reads the user's *learning* history: learning-template tasks,
 * weekly check-ins and the latest recall score. Applied to a fitness goal it
 * writes a number that has nothing to do with that goal (the review measured a
 * fake 18%–38%), so every other domain is left alone.
 */
export const LEARNING_GOAL_DOMAIN = "learning";

export async function recalculateGoalProgress(
  tx: Tx,
  userId: string,
  goalId: string,
  config: LearningConfig,
): Promise<void> {
  // Both callers below need the same answer, and two more call this directly:
  // tasks/create.ts and tasks/audit.ts pass whichever goal the task belongs to.
  // So the guard lives here — a caller-side filter alone would still let an
  // audited health goal be overwritten with a learning score.
  const [goal] = await tx
    .select({ domain: goals.domain })
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.userId, userId)));
  if (!goal || goal.domain !== LEARNING_GOAL_DOMAIN) return;

  const [user] = await tx
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId));
  const timezone = user?.timezone ?? "UTC";
  const range = weekRange(new Date(), timezone);

  const [taskRows, checkinRows, latestCheckinRows] = await Promise.all([
    tx
      .select({ status: tasks.status })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.goalId, goalId),
          inArray(tasks.template, [...LEARNING_TEMPLATES]),
          // 撤回的任务不是"该通过却没通过"，它连题目都撤掉了。cancel 是终态，
          // 留在分母里就等于给进度按上一个永远解不开的上限：用户越早发现题
          // 出得不对、越早取消，代价越大。plan 出去的任务仍然算数（那才是
          // "还有活没干"），cancelled 不算。
          ne(tasks.status, "cancelled"),
        ),
      ),
    tx
      .select({ id: checkins.id })
      .from(checkins)
      .where(
        and(
          eq(checkins.userId, userId),
          gte(checkins.date, localDateKey(range.start, timezone)),
          lt(checkins.date, localDateKey(range.end, timezone)),
        ),
      ),
    // 最近一次**记下了分数**的回忆正确率，不是"最近一条打卡的分数"。
    //
    // recall_score 是选填的：同一天的打卡再存一次、把这一栏留空，就会把昨天
    // 那个真实的 0.4 覆盖成 null，而 computeLearningProgress 把 null 当 0 分算
    // —— 用户只是今天没再自评一次，进度却掉了一整个回忆权重。"这一栏空着"说的
    // 是"没测"，不是"测出来 0%"；分数只在有证据时更新，没有证据时沿用最近一次
    // 已知的（一次都没测过才真的是 0 分）。
    tx
      .select({ recallScore: checkins.recallScore })
      .from(checkins)
      .where(and(eq(checkins.userId, userId), isNotNull(checkins.recallScore)))
      .orderBy(desc(checkins.date))
      .limit(1),
  ]);

  const acceptedLearningTasks = taskRows.filter((task) =>
    ["accepted", "done"].includes(task.status),
  ).length;
  const latestRecallScore = latestCheckinRows[0]?.recallScore ?? null;
  const progress = computeLearningProgress({
    acceptedLearningTasks,
    totalLearningTasks: taskRows.length,
    latestRecallScore,
    checkinsThisWeek: checkinRows.length,
    config,
  });

  await tx
    .update(goals)
    .set({ progress })
    .where(and(eq(goals.id, goalId), eq(goals.userId, userId)));
}

export async function recalculateUserGoalProgress(
  tx: Tx,
  userId: string,
  config: LearningConfig,
): Promise<void> {
  const rows = await tx
    .select({ id: goals.id })
    .from(goals)
    .where(
      and(
        eq(goals.userId, userId),
        eq(goals.status, "active"),
        // The callee re-checks this; filtering here only avoids re-reading the
        // learning history once per non-learning goal.
        eq(goals.domain, LEARNING_GOAL_DOMAIN),
      ),
    );
  for (const goal of rows) {
    await recalculateGoalProgress(tx, userId, goal.id, config);
  }
}
