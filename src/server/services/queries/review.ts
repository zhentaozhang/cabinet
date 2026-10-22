import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
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
/** Hard ceiling for the audit fold; window semantics are preserved. */
const MAX_AUDIT_ROWS = 2000;

export type ReviewPageOptions = {
  insightOffset?: number;
  dissentOffset?: number;
  limit?: number;
};

export async function getReviewData(
  userId: string,
  options: ReviewPageOptions = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const insightOffset = Math.max(options.insightOffset ?? 0, 0);
  const dissentOffset = Math.max(options.dissentOffset ?? 0, 0);
  // One round-trip instead of eleven: none of these reads depend on another.
  const [
    workspace,
    weeklyRows,
    insightCountRows,
    allInsights,
    allAgents,
    allTasks,
    recentAudit,
    dissentCountRows,
    allDissents,
    config,
    auditRows,
    weeklyMetrics,
  ] = await Promise.all([
    getWorkspace(userId),
    db
      .select()
      .from(reviews)
      .where(and(eq(reviews.userId, userId), eq(reviews.type, "weekly")))
      .orderBy(desc(reviews.createdAt))
      .limit(1),
    db
      .select({
        total: sql<number>`count(*)`,
        proposed: sql<number>`count(*) filter (where ${insights.status} = 'proposed')`,
        applied: sql<number>`count(*) filter (where ${insights.status} = 'applied')`,
      })
      .from(insights)
      .where(eq(insights.userId, userId)),
    db
      .select()
      .from(insights)
      .where(eq(insights.userId, userId))
      .orderBy(desc(insights.createdAt), desc(insights.id))
      .limit(limit)
      .offset(insightOffset),
    db
      .select()
      .from(agents)
      .where(eq(agents.userId, userId))
      .orderBy(asc(agents.createdAt)),
    db
      .select()
      .from(tasks)
      .where(eq(tasks.userId, userId))
      .orderBy(desc(tasks.updatedAt))
      .limit(200),
    db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.userId, userId))
      .orderBy(desc(auditEvents.createdAt))
      .limit(12),
    db
      .select({
        total: sql<number>`count(*)`,
        pending: sql<number>`count(*) filter (where ${dissents.status} = 'pending')`,
      })
      .from(dissents)
      .where(eq(dissents.userId, userId)),
    db
      .select()
      .from(dissents)
      .where(eq(dissents.userId, userId))
      .orderBy(desc(dissents.createdAt), desc(dissents.id))
      .limit(limit)
      .offset(dissentOffset),
    getPolicyConfig(),
    // The fold below only keeps `passRateWindow` events per agent, so reading
    // the whole ledger was unbounded growth for no gain. Newest-first is the
    // same window semantics; the cap is far above any legal window.
    db
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
      .orderBy(desc(auditEvents.seq))
      .limit(MAX_AUDIT_ROWS),
    getWeeklyMetrics(userId),
  ]);

  const { user, profile } = workspace;
  const weekly = weeklyRows[0];
  const [insightCounts] = insightCountRows;
  const [dissentCounts] = dissentCountRows;

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
    insightTotal: Number(insightCounts?.total ?? 0),
    insightProposedTotal: Number(insightCounts?.proposed ?? 0),
    dissentTotal: Number(dissentCounts?.total ?? 0),
    dissentPendingTotal: Number(dissentCounts?.pending ?? 0),
    insightOffset,
    dissentOffset,
    limit,
    auditStats,
    config,
    weeklyMetrics,
  };
}
