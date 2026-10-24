import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import type { Tx } from "../shared/tx";
import { checkins, goals, tasks, users } from "@/lib/db/schema";
import { localDateKey, weekRange } from "@/lib/domain/time";
import { computeLearningProgress } from "@/lib/domain/learning-progress";
import type { LearningConfig } from "@/lib/domain/policy";

export const LEARNING_TEMPLATES = ["learning", "learning_retest"] as const;

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
    tx
      .select({ recallScore: checkins.recallScore })
      .from(checkins)
      .where(eq(checkins.userId, userId))
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
