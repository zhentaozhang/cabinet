import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import type { Tx } from "../shared/tx";
import { checkins, goals, tasks, users } from "@/lib/db/schema";
import { localDateKey, weekRange } from "@/lib/domain/time";
import { computeLearningProgress } from "@/lib/domain/learning-progress";
import type { LearningConfig } from "@/lib/domain/policy";

export const LEARNING_TEMPLATES = ["learning", "learning_retest"] as const;

export async function recalculateGoalProgress(
  tx: Tx,
  userId: string,
  goalId: string,
  config: LearningConfig,
): Promise<void> {
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
    .where(and(eq(goals.userId, userId), eq(goals.status, "active")));
  for (const goal of rows) {
    await recalculateGoalProgress(tx, userId, goal.id, config);
  }
}
