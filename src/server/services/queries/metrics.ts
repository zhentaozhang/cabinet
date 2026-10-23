import { and, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agents,
  auditEvents,
  checkins,
  goals,
  runs,
  steps,
  tasks,
  userActions,
  users,
} from "@/lib/db/schema";
import { addLocalDays, localDateKey, weekRange } from "@/lib/domain/time";
import { LEARNING_TEMPLATES } from "@/lib/domain/learning";
import { getPolicyConfig } from "@/lib/policy/config";

/** Tools that are billed per request rather than per token. */
const BILLABLE_TOOLS = ["web_search", "web_fetch"] as const;

/**
 * What one external retrieval costs, in cents.
 *
 * Unset (or 0) means the deployment has not priced them, so the UI says
 * "未计价" instead of inventing a number. This never feeds `costCents`: the
 * model budget and the retrieval budget are different curves and mixing them
 * would make the weekly cap meaningless.
 */
const SEARCH_COST_CENTS_PER_REQUEST = (() => {
  const raw = Number(process.env.SEARCH_COST_CENTS_PER_REQUEST ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
})();
export async function getWeeklyMetrics(userId: string) {
  const [userRows, config] = await Promise.all([
    db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId)),
    getPolicyConfig(),
  ]);
  const timezone = userRows[0]?.timezone ?? "UTC";
  const range = weekRange(new Date(), timezone);
  const now = new Date();
  const endOfToday = addLocalDays(now, 1, timezone);

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
    db
      .select()
      .from(goals)
      .where(and(eq(goals.userId, userId), eq(goals.status, "active")))
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
        ),
      ),
    /*
     * External retrieval is counted separately from model tokens: a search has
     * a per-request price, not a token price, and folding guesses about it into
     * `costCents` would make the budget lie. Only calls that reached a provider
     * count — `not_connected`, `unauthorized` and `skipped` were never billed.
     */
    db
      .select({ requests: sql<number>`count(*)` })
      .from(steps)
      .innerJoin(runs, eq(steps.runId, runs.id))
      .innerJoin(agents, eq(runs.agentId, agents.id))
      .where(
        and(
          eq(agents.userId, userId),
          eq(steps.type, "tool"),
          inArray(steps.tool, [...BILLABLE_TOOLS]),
          sql`${steps.output}->>'status' in ('ok', 'timeout', 'invalid_response', 'rate_limited')`,
          gte(runs.startedAt, range.start),
          lt(runs.startedAt, range.end),
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
      // 0 means "unpriced", not "free": the connector price is a deployment
      // setting, and pretending a number would be worse than reporting none.
      priceCents: SEARCH_COST_CENTS_PER_REQUEST,
      estimatedCents: Number(searchRow?.requests ?? 0) * SEARCH_COST_CENTS_PER_REQUEST,
    },
    goalProgress: goal?.progress ?? 0,
    auditRejectRate: auditTotal > 0 ? (rejects / auditTotal) * 100 : null,
    sample: { planned, completed, accepts, rejects },
  };
}
