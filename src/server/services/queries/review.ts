import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  auditEvents,
  dissents,
  insights,
  reviews,
  tasks,
} from "@/lib/db/schema";
import { getPolicyConfigFor } from "@/lib/policy/config";
import { loadAutonomyDecisions } from "./autonomy";
import { loadAuditWindows } from "./audit-samples";
import { getWeeklyMetrics } from "./metrics";
import { getWorkspace } from "./workspace";

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
    auditCountRows,
    dissentCountRows,
    allDissents,
    config,
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
      .select({ total: sql<number>`count(*)` })
      .from(auditEvents)
      .where(eq(auditEvents.userId, userId)),
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
    getPolicyConfigFor(userId),
    getWeeklyMetrics(userId),
  ]);
  // The audit window is read through the same eligibility filter the promotion
  // command uses, so the badge on this page cannot disagree with the write.
  const [auditWindows, autonomyDecisions] = await Promise.all([
    loadAuditWindows(userId, config.audit.passRateWindow),
    loadAutonomyDecisions(userId),
  ]);

  const { user, profile } = workspace;
  const weekly = weeklyRows[0];
  const [insightCounts] = insightCountRows;
  const [dissentCounts] = dissentCountRows;
  const [auditCounts] = auditCountRows;

  // Only eligible samples feed performance statistics: demo, rule-generated,
  // user-submitted and pre-ledger output are audited but never counted.
  const auditStats: Record<
    string,
    { accepts: number; total: number; passRate: number }
  > = {};
  for (const [agentId, window] of auditWindows) {
    const accepts = window.eligibleSamples.filter(
      (sample) => sample.action === "audit.accept",
    ).length;
    auditStats[agentId] = {
      accepts,
      total: window.eligibleSamples.length,
      passRate: window.passRate,
    };
  }

  return {
    user,
    profile,
    weekly: weekly ?? null,
    insights: allInsights,
    agents: allAgents,
    tasks: allTasks,
    audit: recentAudit,
    auditTotal: Number(auditCounts?.total ?? 0),
    dissents: allDissents,
    insightTotal: Number(insightCounts?.total ?? 0),
    insightProposedTotal: Number(insightCounts?.proposed ?? 0),
    dissentTotal: Number(dissentCounts?.total ?? 0),
    dissentPendingTotal: Number(dissentCounts?.pending ?? 0),
    insightOffset,
    dissentOffset,
    limit,
    auditStats,
    autonomyDecisions,
    config,
    weeklyMetrics,
  };
}
