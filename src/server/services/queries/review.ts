import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  auditEvents,
  dissents,
  insights,
  reviews,
  tasks,
} from "@/lib/db/schema";
import { getPolicyConfig } from "@/lib/policy/config";
import { getWeeklyMetrics } from "./metrics";
import { getWorkspace } from "./workspace";
export async function getReviewData(userId: string) {
  const { user, profile } = await getWorkspace(userId);
  const [weekly] = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.userId, userId), eq(reviews.type, "weekly")))
    .orderBy(desc(reviews.createdAt))
    .limit(1);
  const allInsights = await db
    .select()
    .from(insights)
    .where(eq(insights.userId, userId))
    .orderBy(desc(insights.createdAt));
  const allAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, userId))
    .orderBy(asc(agents.createdAt));
  const allTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.userId, userId));
  const recentAudit = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.userId, userId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(12);
  const allDissents = await db
    .select()
    .from(dissents)
    .where(eq(dissents.userId, userId))
    .orderBy(desc(dissents.createdAt));

  const config = await getPolicyConfig();
  const auditRows = await db
    .select({
      assigneeId: tasks.assigneeId,
      action: auditEvents.action,
    })
    .from(auditEvents)
    .innerJoin(tasks, eq(tasks.id, auditEvents.target))
    .where(
      and(
        eq(auditEvents.userId, userId),
        inArray(auditEvents.action, ["audit.accept", "audit.reject"]),
      ),
    )
    .orderBy(desc(auditEvents.seq));

  const auditStats: Record<
    string,
    { accepts: number; total: number; passRate: number }
  > = {};
  for (const row of auditRows) {
    if (!row.assigneeId) continue;
    const current = auditStats[row.assigneeId] ?? {
      accepts: 0,
      total: 0,
      passRate: 0,
    };
    if (current.total >= config.audit.passRateWindow) continue;
    current.total += 1;
    if (row.action === "audit.accept") current.accepts += 1;
    current.passRate = current.accepts / current.total;
    auditStats[row.assigneeId] = current;
  }

  return {
    user,
    profile,
    weekly: weekly ?? null,
    insights: allInsights,
    agents: allAgents,
    tasks: allTasks,
    audit: recentAudit,
    dissents: allDissents,
    auditStats,
    config,
    weeklyMetrics: await getWeeklyMetrics(userId),
  };
}
