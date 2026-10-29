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
import { METERED_RETRIEVAL_TOOLS } from "@/lib/domain/retrieval-billing";
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

  // 按次计费的工具。抓指名页面的行单价恒为 0，那是「不收费」而不是「没定价」，
  // 两者混在一起数，配了单价的部署也会被报成「本周检索未计价」。
  const meteredTool = sql`${retrievalCalls.tool} in (${sql.join(
    METERED_RETRIEVAL_TOOLS.map((tool) => sql`${tool}`),
    sql`, `,
  )})`;

  /**
   * 待判定必须是"现在仍停着"的，所以按任务当前状态过滤，而不是只数事件。
   *
   * 审计事件只记录"曾经停过"：用户判定（audit.override）或放弃（cancel）之后
   * 任务已经离开 needs_review。复盘页那行写着「本周有 N 条停在你这里」，
   * 首页的待办队列却按 tasks.status 现算——只数事件就会出现同一周两个页面
   * 说法相反，而且是那句"停在你这里"在说谎。
   *
   * `distinct` 去重到任务粒度：被驳回后重新验收可能再次落回待判定。
   */
  const stillPending = sql`exists (
    select 1 from ${tasks} as pending_task
    where pending_task.id = ${auditEvents.target}
      and pending_task.status = 'needs_review'
  )`;

  /**
   * 一道复测的「结论」有两种来源：Auditor 自己给的（audit.accept / audit.reject），
   * 以及它判不了、你在待判定时接手给的（audit.override，after.status 记的就是
   * accepted / rejected）。只认前者，一道"模型拿不准、最后由你判通过"的复测就
   * 不会算进这一周——而那恰恰是离线用户的常态。
   */
  const verdictRow = sql`(${auditEvents.action} in ('audit.accept', 'audit.reject') or (${auditEvents.action} = 'audit.override' and ${auditEvents.after} ->> 'status' in ('accepted', 'rejected')))`;
  const acceptedVerdict = sql`(${auditEvents.action} = 'audit.accept' or (${auditEvents.action} = 'audit.override' and ${auditEvents.after} ->> 'status' = 'accepted'))`;
  // 子查询里这一行是别名，不能复用上面按表名渲染的片段。
  const laterVerdictRow = sql`(later_verdict.action in ('audit.accept', 'audit.reject') or (later_verdict.action = 'audit.override' and later_verdict.after ->> 'status' in ('accepted', 'rejected')))`;

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
    // 撤回的计划不算「没做到」。目标进度（commands/progress.ts）与复测通过率
    // 都把 cancelled 排除在分母外；遵从率问的是同一件事（本周的计划做到没有），
    // 留着这条任务就等于让一次主动撤回永久压低首页那个百分比。
    db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          gte(tasks.dueAt, range.start),
          lte(tasks.dueAt, endOfToday),
          ne(tasks.status, "cancelled"),
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
        // 而且只数仍然停在 needs_review 的那些（见上面的 stillPending）。
        pendingReview: sql<number>`count(distinct ${auditEvents.target}) filter (
          where ${auditEvents.action} = 'audit.needs_review' and ${stillPending}
        )`,
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
    // 按 accepted_at 归周，不按 created_at：上周三布置、这一周才验收的学习任务，
    // 上周那篇复盘生成时它还没做完，这一周又被 created_at 挡在窗外——两次复盘都
    // 不提它。完成发生在验收那一刻，遵从率的分子（上面那条）也是这么算的。
    // 状态条件留着：验收过又被撤回的异常行不该混进这个数。
    db
      .select({
        accepted: sql<number>`count(*) filter (where ${tasks.status} in ('accepted', 'done'))`,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          inArray(tasks.template, [...LEARNING_TEMPLATES]),
          gte(tasks.acceptedAt, range.start),
          lt(tasks.acceptedAt, range.end),
        ),
      ),
    // 复测通过率问的是「这一周判过的复测里过了几条」。按 tasks.created_at 归周
    // 会把两件事一起说错：上周排的复测这一周才判，判完就从窗口里消失（上周那篇
    // 复盘写它时还没有结论），而这一周还没判的那道又被当成「没通过」留在分母里
    // ——README 和任务页都写着「未判定不算失败」，首页那个百分比却在按失败算。
    // 结论记在审计行上（target = 任务 id）。同一道题驳回后重做再验收会再落一行，
    // 所以只认这道题最后一条结论（seq 最大），并用任务当前状态把撤回的排除掉
    // ——自己撤掉的题不算「没通过」，与目标进度同一条规则。
    db
      .select({
        total: sql<number>`count(*)`,
        accepted: sql<number>`count(*) filter (where ${acceptedVerdict})`,
      })
      .from(auditEvents)
      .innerJoin(tasks, eq(tasks.id, auditEvents.target))
      .where(
        and(
          eq(auditEvents.userId, userId),
          eq(tasks.template, "learning_retest"),
          ne(tasks.status, "cancelled"),
          verdictRow,
          gte(auditEvents.createdAt, range.start),
          lt(auditEvents.createdAt, range.end),
          sql`not exists (
            select 1 from ${auditEvents} as later_verdict
            where later_verdict.target = ${auditEvents.target}
              and later_verdict.seq > ${auditEvents.seq}
              and (${laterVerdictRow})
          )`,
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
        unpriced: sql<number>`count(*) filter (where ${sent} and ${meteredTool} and ${retrievalCalls.unitPriceCents} = 0)`,
        // 按次计费之外的工具（目前只有抓页面）发出去也不收钱，单独报，别混进未计价。
        freeRequests: sql<number>`count(*) filter (where ${sent} and not (${meteredTool}))`,
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
      // 已经发出去、但工具本身不按次计费的调用：不是「没定价」，是「不收费」。
      freeRequests: Number(searchRow?.freeRequests ?? 0),
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
