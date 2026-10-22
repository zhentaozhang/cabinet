import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  approvals,
  checkins,
  councils,
  goals,
  reviews,
  tasks,
} from "@/lib/db/schema";
import { addLocalDays, localDateKey } from "@/lib/domain/time";
import { getWeeklyMetrics } from "./metrics";
import { getWorkspace } from "./workspace";
export async function getTodayData(userId: string) {
  const { user, profile } = await getWorkspace(userId);
  const allAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, userId))
    .orderBy(asc(agents.createdAt));
  const allGoals = await db
    .select()
    .from(goals)
    .where(eq(goals.userId, userId));
  const openTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        inArray(tasks.status, [
          "planned",
          "assigned",
          "awaiting_approval",
          "approved",
          "suggested",
          "running",
          "submitted",
          "rejected",
        ]),
      ),
    )
    .orderBy(asc(tasks.dueAt));
  const pendingApprovals = await db
    .select()
    .from(approvals)
    .where(
      and(eq(approvals.userId, userId), eq(approvals.status, "pending")),
    )
    .orderBy(asc(approvals.createdAt));
  const [openCouncil] = await db
    .select()
    .from(councils)
    .where(and(eq(councils.userId, userId), eq(councils.status, "open")))
    .orderBy(desc(councils.createdAt))
    .limit(1);
  const todayKey = localDateKey(new Date(), user.timezone);
  const yesterdayKey = localDateKey(
    addLocalDays(new Date(), -1, user.timezone),
    user.timezone,
  );
  const [todayCheckin] = await db
    .select()
    .from(checkins)
    .where(
      and(eq(checkins.userId, userId), eq(checkins.date, todayKey)),
    )
    .limit(1);
  const [yesterdayCheckin] = await db
    .select()
    .from(checkins)
    .where(
      and(eq(checkins.userId, userId), eq(checkins.date, yesterdayKey)),
    )
    .limit(1);
  const [dailyReview] = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.userId, userId), eq(reviews.type, "daily")))
    .orderBy(desc(reviews.createdAt))
    .limit(1);
  const weeklyMetrics = await getWeeklyMetrics(userId);

  return {
    user,
    profile,
    agents: allAgents,
    goals: allGoals,
    tasks: openTasks,
    approvals: pendingApprovals,
    council: openCouncil ?? null,
    checkin: todayCheckin ?? null,
    yesterdayCheckin: yesterdayCheckin ?? null,
    brief: dailyReview ?? null,
    weeklyMetrics,
  };
}
