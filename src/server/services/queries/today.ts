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
import { getWeeklyMetrics, getWeeklySpendByAgent } from "./metrics";
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
    spendByAgent,
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
            // A failed task is not finished work: it is the state that most
            // needs a human decision (retry, fix, or abandon). Filtering it out
            // meant Today could never answer "what went wrong". This is a
            // read-model widening only — no new domain status is introduced.
            "failed",
            // 同理：验收说"没有结论"的任务最需要人出现，漏掉它，
            // Today 就会在一个任务明确等人时显示"没有需要你处理的事"。
            "needs_review",
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
    // Same ledger rows as `weeklyMetrics.costCents`, split by agent: the
    // spend card names the biggest spender next to that total, so a second
    // source (the frozen `agents.spentCents` column) made the card
    // contradict itself.
    getWeeklySpendByAgent(userId),
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
    // null rather than a zero-valued stand-in: the card shows nothing when
    // there is nobody to name.
    topSpender: spendByAgent.find((row) => row.cents > 0) ?? null,
  };
}
