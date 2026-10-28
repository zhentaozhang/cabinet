import { and, desc, eq, gte, inArray, lt, lte, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agents,
  auditEvents,
  checkins,
  goals,
  retrievalCalls,
  tasks,
  userActions,
  users,
} from "@/lib/db/schema";
import { addLocalDays, localDateKey, weekRange } from "@/lib/domain/time";
import { LEARNING_TEMPLATES } from "@/lib/domain/learning";
import { retrievalUnitPriceCents } from "@/lib/config/pricing";
import { CONTACT_STATUSES } from "@/lib/domain/contact";
import { getPolicyConfigFor } from "@/lib/policy/config";

/**
 * What one external retrieval costs, in cents.
 *
 * Unset (or 0) means the deployment has not priced them, so the UI says
 * "未计价" instead of inventing a number. This never feeds `costCents`: the
 * model budget and the retrieval budget are different curves and mixing them
 * would make the weekly cap meaningless.
 */

/**
 * The reader's local week window, and the zone that defines it.
 *
 * Shared by every weekly spend query: a total and its breakdown are only
 * comparable when they are cut from the same interval, and a second hand-rolled
 * week boundary is a second chance for the two numbers to disagree.
 */
async function weeklyWindow(userId: string) {
  const userRows = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId));
  const timezone = userRows[0]?.timezone ?? "UTC";
  return { timezone, range: weekRange(new Date(), timezone) };
}

export async function getWeeklyMetrics(userId: string) {
  const [{ timezone, range }, config] = await Promise.all([
    weeklyWindow(userId),
    getPolicyConfigFor(userId),
  ]);
  const now = new Date();
  const endOfToday = addLocalDays(now, 1, timezone);

  // "发出去过"的唯一判据，来自 domain/contact（扣钱与预算台账用的是同一份）。
  const sent = sql`${retrievalCalls.status} in (${sql.join(
    CONTACT_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  )})`;

  // Every aggregate below is independent; one round-trip instead of eight.
  const [
    aaoRows,
    plannedRows,
    completedRows,
    costRows,
    auditRows,
    actionRows,
    decisionRows,
    goalRows,
    studyRows,
    learningRows,
    retestRows,
    searchRows,
  ] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          gte(tasks.acceptedAt, range.start),
          lt(tasks.acceptedAt, range.end),
          gte(tasks.acceptedAutonomyLevel, 2),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          gte(tasks.dueAt, range.start),
          lte(tasks.dueAt, endOfToday),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          gte(tasks.dueAt, range.start),
          lte(tasks.dueAt, endOfToday),
          inArray(tasks.status, ["accepted", "done"]),
        ),
      ),
    // Estimated weekly model spend comes from the budget ledger, not from
    // `runs.cost_cents` telemetry.
    db
      .select({
        total: sql<number>`coalesce(sum(${agentBudgetPeriods.settledCents} + ${agentBudgetPeriods.unknownCents}), 0)`,
      })
      .from(agentBudgetPeriods)
      .innerJoin(agents, eq(agents.id, agentBudgetPeriods.agentId))
      .where(
        and(
          eq(agents.userId, userId),
          gte(agentBudgetPeriods.periodStart, range.start),
          lt(agentBudgetPeriods.periodStart, range.end),
        ),
      ),
    db
      .select({
        accepts: sql<number>`count(*) filter (where ${auditEvents.action} = 'audit.accept')`,
        rejects: sql<number>`count(*) filter (where ${auditEvents.action} = 'audit.reject')`,
        // 待判定单独计数：它既不是通过也不是驳回，把它算进任何一边都会
        // 让通过率说谎（算进分母像是判过了，算进分子像是在变好）。
        pendingReview: sql<number>`count(*) filter (where ${auditEvents.action} = 'audit.needs_review')`,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, userId),
          gte(auditEvents.createdAt, range.start),
          lt(auditEvents.createdAt, range.end),
        ),
      ),
    db
      .select({ total: sql<number>`coalesce(sum(${userActions.durationMs}), 0)` })
      .from(userActions)
      .where(
        and(
          eq(userActions.userId, userId),
          gte(userActions.createdAt, range.start),
          lt(userActions.createdAt, range.end),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, userId),
          eq(auditEvents.actor, "user"),
          gte(auditEvents.createdAt, range.start),
          lt(auditEvents.createdAt, range.end),
        ),
      ),
    /*
     * 这一屏的其余数字（打卡 / 回忆分 / 学习任务 / 复测）全是学习口径，
     * 所以「目标进度」也只能是学习目标的：种子里同时有两个活跃目标，
     * 原来的 status = 'active' limit 1 没有 order by，报哪一个取决于数据库
     * 的物理顺序，同一周重新生成一次就可能换成另一个目标的数字。order by
     * 再带上 id 兜底，是因为同一事务里插入的两行 created_at 完全相同
     *（now() 取事务开始时间），只按时间排仍然是任意的。
     */
    db
      .select({ progress: goals.progress })
      .from(goals)
      .where(
        and(
          eq(goals.userId, userId),
          eq(goals.status, "active"),
          eq(goals.domain, "learning"),
        ),
      )
      .orderBy(desc(goals.createdAt), desc(goals.id))
      .limit(1),
    db
      .select({
        minutes: sql<number>`coalesce(sum(${checkins.studyMinutes}), 0)`,
        recall: sql<number | null>`avg(${checkins.recallScore})`,
      })
      .from(checkins)
      .where(
        and(
          eq(checkins.userId, userId),
          gte(checkins.date, localDateKey(range.start, timezone)),
          lt(checkins.date, localDateKey(range.end, timezone)),
        ),
      ),
    db
      .select({
        accepted: sql<number>`count(*) filter (where ${tasks.status} in ('accepted', 'done'))`,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          inArray(tasks.template, [...LEARNING_TEMPLATES]),
          gte(tasks.createdAt, range.start),
          lt(tasks.createdAt, range.end),
        ),
      ),
    db
      .select({
        total: sql<number>`count(*)`,
        accepted: sql<number>`count(*) filter (where ${tasks.status} in ('accepted', 'done'))`,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.template, "learning_retest"),
          gte(tasks.createdAt, range.start),
          lt(tasks.createdAt, range.end),
          // 撤回的重测不算"没通过"：分母里混进一条自己撤销的题，通过率就
          // 永远差这一块。目标进度用的是同一条规则（commands/progress.ts）。
          ne(tasks.status, "cancelled"),
        ),
      ),
    /*
     * External retrieval is billed from its own ledger, not from tool steps:
     * the step is a trace, the ledger holds the price that applied at call time
     * plus calls that returned nothing (which were still charged). Model tokens
     * stay in `costCents`; mixing the two curves would make the weekly cap lie.
     */
    db
      .select({
        // 只数真正发出去的请求。被预算拒掉的调用也落一行台账（那行记的是
        // "没有产生费用"），把它算成一次请求会让页面上的"本周检索 N 次"
        // 与"本周检索花费"互相矛盾。谓词与扣钱、与预算台账共用同一份定义。
        requests: sql<number>`count(*) filter (where ${sent})`,
        charged: sql<number>`coalesce(sum(${retrievalCalls.chargedCents}), 0)`,
        unpriced: sql<number>`count(*) filter (where ${sent} and ${retrievalCalls.unitPriceCents} = 0)`,
      })
      .from(retrievalCalls)
      .where(
        and(
          eq(retrievalCalls.userId, userId),
          gte(retrievalCalls.createdAt, range.start),
          lt(retrievalCalls.createdAt, range.end),
        ),
      ),
  ]);

  const [aaoRow] = aaoRows;
  const [plannedRow] = plannedRows;
  const [completedRow] = completedRows;
  const [costRow] = costRows;
  const [auditRow] = auditRows;
  const [actionsRow] = actionRows;
  const [decisionRow] = decisionRows;
  const [searchRow] = searchRows;
  const [goal] = goalRows;
  const [studyRow] = studyRows;
  const [learningRow] = learningRows;
  const [retestRow] = retestRows;

  const planned = Number(plannedRow?.count ?? 0);
  const completed = Number(completedRow?.count ?? 0);
  const actionsMs = Number(actionsRow?.total ?? 0);
  // No measured actions and no user-decision samples means we have nothing to
  // report — not "zero minutes".
  const decisionSamples = Number(decisionRow?.count ?? 0);
  const managementMinutes =
    actionsMs > 0
      ? actionsMs / 60000
      : decisionSamples > 0
        ? decisionSamples * config.management.minutesPerDecision
        : null;
  const accepts = Number(auditRow?.accepts ?? 0);
  const rejects = Number(auditRow?.rejects ?? 0);
  const pendingReview = Number(auditRow?.pendingReview ?? 0);
  const auditTotal = accepts + rejects;
  const retestTotal = Number(retestRow?.total ?? 0);

  return {
    weekKey: range.key,
    aao: Number(aaoRow?.count ?? 0),
    adherence: planned > 0 ? (completed / planned) * 100 : null,
    managementMinutes,
    managementMinutesSource: actionsMs > 0 ? "measured" : "estimated",
    studyMinutes: Number(studyRow?.minutes ?? 0),
    recallAvg:
      studyRow?.recall === null || studyRow?.recall === undefined
        ? null
        : Number(studyRow.recall),
    learningTasks: Number(learningRow?.accepted ?? 0),
    retestPassRate:
      retestTotal > 0
        ? (Number(retestRow?.accepted ?? 0) / retestTotal) * 100
        : null,
    costCents: Number(costRow?.total ?? 0),
    search: {
      requests: Number(searchRow?.requests ?? 0),
      // The price in force right now, for display only; the money total comes
      // from the per-call snapshots so old weeks never re-price themselves.
      priceCents: retrievalUnitPriceCents(),
      estimatedCents: Number(searchRow?.charged ?? 0),
      // 0 means "unpriced", not "free": the connector price is a deployment
      // setting, and pretending a number would be worse than reporting none.
      unpricedRequests: Number(searchRow?.unpriced ?? 0),
    },
    // 没有活跃的学习目标就是「没有这个数」，不是 0%——和 adherence /
    // retestPassRate 一样，缺样本用 null，别让页面印一个假的 0。
    goalProgress: goal ? Number(goal.progress) : null,
    auditRejectRate: auditTotal > 0 ? (rejects / auditTotal) * 100 : null,
    sample: { planned, completed, accepts, rejects, pendingReview },
  };
}
/**
 * This week's model spend, split by agent.
 *
 * Same rows, same window and same tenancy join as the `costCents` total above.
 * The Today card prints that total and names the biggest spender right beside
 * it, so the two must be two views of one sum — reading the second one from
 * `agents.spent_cents` (frozen legacy, database default 0, never written at
 * runtime) is how the same card ended up quoting two different facts.
 */
export async function getWeeklySpendByAgent(
  userId: string,
): Promise<{ agentId: string; name: string; cents: number }[]> {
  const { range } = await weeklyWindow(userId);
  const spent = sql<number>`coalesce(sum(${agentBudgetPeriods.settledCents} + ${agentBudgetPeriods.unknownCents}), 0)`;
  const rows = await db
    .select({ agentId: agents.id, name: agents.name, cents: spent })
    .from(agentBudgetPeriods)
    .innerJoin(agents, eq(agents.id, agentBudgetPeriods.agentId))
    .where(
      and(
        eq(agents.userId, userId),
        gte(agentBudgetPeriods.periodStart, range.start),
        lt(agentBudgetPeriods.periodStart, range.end),
      ),
    )
    .groupBy(agents.id, agents.name)
    .orderBy(desc(spent));

  return rows.map((row) => ({
    agentId: row.agentId,
    name: row.name,
    cents: Number(row.cents),
  }));
}
