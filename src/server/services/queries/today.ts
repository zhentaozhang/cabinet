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
  // Batch 1: everything that only needs `userId`. These are independent
  // SELECTs, so issuing them together removes ~8 serial round-trips.
  const [
    workspace,
    allAgents,
    allGoals,
    openTasks,
    pendingApprovals,
    openCouncilRows,
    dailyReviewRows,
    weeklyMetrics,
  ] = await Promise.all([
    getWorkspace(userId),
    db
      .select()
      .from(agents)
      .where(eq(agents.userId, userId))
      .orderBy(asc(agents.createdAt)),
    db.select().from(goals).where(eq(goals.userId, userId)),
    db
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
      .orderBy(asc(tasks.dueAt)),
    db
      .select()
      .from(approvals)
      .where(
        and(eq(approvals.userId, userId), eq(approvals.status, "pending")),
      )
      .orderBy(asc(approvals.createdAt)),
    db
      .select()
      .from(councils)
      .where(and(eq(councils.userId, userId), eq(councils.status, "open")))
      .orderBy(desc(councils.createdAt))
      .limit(1),
    db
      .select()
      .from(reviews)
      .where(and(eq(reviews.userId, userId), eq(reviews.type, "daily")))
      .orderBy(desc(reviews.createdAt))
      .limit(1),
    getWeeklyMetrics(userId),
  ]);

  const { user, profile } = workspace;
  // Batch 2: check-in keys depend on the user's timezone.
  const todayKey = localDateKey(new Date(), user.timezone);
  const yesterdayKey = localDateKey(
    addLocalDays(new Date(), -1, user.timezone),
    user.timezone,
  );

  const [todayCheckinRows, yesterdayCheckinRows] = await Promise.all([
    db
      .select()
      .from(checkins)
      .where(and(eq(checkins.userId, userId), eq(checkins.date, todayKey)))
      .limit(1),
    db
      .select()
      .from(checkins)
      .where(and(eq(checkins.userId, userId), eq(checkins.date, yesterdayKey)))
      .limit(1),
  ]);

  return {
    user,
    profile,
    agents: allAgents,
    goals: allGoals,
    tasks: openTasks,
    approvals: pendingApprovals,
    council: openCouncilRows[0] ?? null,
    checkin: todayCheckinRows[0] ?? null,
    yesterdayCheckin: yesterdayCheckinRows[0] ?? null,
    brief: dailyReviewRows[0] ?? null,
    weeklyMetrics,
  };
}
