import { and, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  auditEvents,
  goals,
  runs,
  tasks,
  userActions,
  users,
} from "@/lib/db/schema";
import { addLocalDays, weekRange } from "@/lib/domain/time";
import { getPolicyConfig } from "@/lib/policy/config";
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
    db
      .select({ total: sql<number>`coalesce(sum(${runs.costCents}), 0)` })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(
        and(
          eq(agents.userId, userId),
          gte(runs.createdAt, range.start),
          lt(runs.createdAt, range.end),
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
  ]);

  const [aaoRow] = aaoRows;
  const [plannedRow] = plannedRows;
  const [completedRow] = completedRows;
  const [costRow] = costRows;
  const [auditRow] = auditRows;
  const [actionsRow] = actionRows;
  const [decisionRow] = decisionRows;
  const [goal] = goalRows;

  const planned = Number(plannedRow?.count ?? 0);
  const completed = Number(completedRow?.count ?? 0);
  const actionsMs = Number(actionsRow?.total ?? 0);
  const managementMinutes =
    actionsMs > 0
      ? actionsMs / 60000
      : Number(decisionRow?.count ?? 0) * config.management.minutesPerDecision;
  const accepts = Number(auditRow?.accepts ?? 0);
  const rejects = Number(auditRow?.rejects ?? 0);
  const auditTotal = accepts + rejects;

  return {
    weekKey: range.key,
    aao: Number(aaoRow?.count ?? 0),
    adherence: planned > 0 ? (completed / planned) * 100 : 0,
    managementMinutes,
    costUsd: Number(costRow?.total ?? 0) / 100,
    goalProgress: goal?.progress ?? 0,
    auditRejectRate: auditTotal > 0 ? (rejects / auditTotal) * 100 : 0,
    sample: { planned, completed, accepts, rejects },
  };
}
