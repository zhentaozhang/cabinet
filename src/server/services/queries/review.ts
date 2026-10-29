import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  auditEvents,
  dissents,
  insights,
  reviews,
  tasks,
} from "@/lib/db/schema";
import { OPEN_TASK_STATUSES } from "@/lib/domain/task-actions";
import { weekRange } from "@/lib/domain/time";
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

/**
 * 「本周改了什么」那张卡只列几行变更，但要说出"这一周一共有多少条生效了"。
 * 口径来自整张表，不是上面那页洞察：洞察先被提出、后来才被采纳，所以
 * 已生效的那几条往往正好落在更早的页上，只按当前页数会把"已生效"说成
 * "没有生效"。
 *
 * 窗口按 `insights.decided_at`（采纳那一刻）算，不按 `created_at`：洞察可能是
 * 上周提出、这周才采纳的，按创建时间会把它挡在这一周之外。也不能不设窗口——
 * 原来数的是整张表里 status = 'applied' 的行，三周前采纳的一条会永远列在
 * 「本周改了什么」下面，而「本周没有已生效的变更」这句从此再也不会出现。
 */
const APPLIED_DIFF_LIMIT = 5;

/** 页面只在未收尾任务里挑一条；排序已经和 pickFocusTask 一致，取 200 条足够宽。 */
const FOCUS_POOL_LIMIT = 200;

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
    // 「下周的唯一目标」只从还没了结的任务里挑：这里原来取的是「最近更新的 200 条」
    // 任务，一个任务多的工作区里，一条更早、优先级更高的未收尾任务会被挤出窗口，
    // 页面却印「没有未收尾的任务」。现在过滤与排序都交给数据库，并且用的就是
    // pickFocusTask 自己那套顺序（优先级升序 → 截止日期升序、无截止排最后 → id），
    // 所以窗口里第一条就是会被挑中的那条。
    db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          inArray(tasks.status, [...OPEN_TASK_STATUSES]),
        ),
      )
      .orderBy(asc(tasks.priority), sql`${tasks.dueAt} asc nulls last`, asc(tasks.id))
      .limit(FOCUS_POOL_LIMIT),
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
  const { user, profile } = workspace;
  // 「本周改了什么」按采纳那一刻归周：`decided_at` 落在本周才列。这条查询要用户的
  // 时区才能算周界，而时区在第一批读里（workspace），所以放在这里而不是第一批。
  const week = weekRange(new Date(), user.timezone ?? "UTC");
  const appliedThisWeek = and(
    eq(insights.userId, userId),
    eq(insights.status, "applied"),
    gte(insights.decidedAt, week.start),
    lt(insights.decidedAt, week.end),
  );
  // The audit window is read through the same eligibility filter the promotion
  // command uses, so the badge on this page cannot disagree with the write.
  const [auditWindows, autonomyDecisions, appliedInsightRows, appliedCountRows] =
    await Promise.all([
      loadAuditWindows(userId, config.audit.passRateWindow),
      loadAutonomyDecisions(userId),
      // 条数与列表同一窗口、同一谓词：条数在整张表里数，展示取最近几条。
      db
        .select()
        .from(insights)
        .where(appliedThisWeek)
        .orderBy(desc(insights.decidedAt), desc(insights.id))
        .limit(APPLIED_DIFF_LIMIT),
      db
        .select({ total: sql<number>`count(*)` })
        .from(insights)
        .where(appliedThisWeek),
    ]);
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
    // 本周已生效的条数（按 decided_at 归周），不是这一页的：卡片要说的是
    // 这一周一共改了什么。
    insightAppliedTotal: Number(appliedCountRows[0]?.total ?? 0),
    appliedInsights: appliedInsightRows,
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
