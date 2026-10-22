import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  auditEvents,
  checkins,
  councils,
  goals,
  memories,
  profiles,
  tasks,
  users,
} from "@/lib/db/schema";
import type { FalsificationCondition } from "@/lib/db/schema";
import { getPolicyConfig } from "@/lib/policy/config";
import { startOfLocalWeek } from "@/lib/domain/time";
import { loadSpentCents } from "../tasks/execution";
import type {
  CouncilPositionDraft,
} from "@/lib/domain/council";
import { ValidationError } from "@/lib/domain/errors";

export type CouncilContext = {
  agents: Array<typeof agents.$inferSelect>;
  profile: typeof profiles.$inferSelect | undefined;
  goals: Array<typeof goals.$inferSelect>;
  tasks: Array<typeof tasks.$inferSelect>;
  checkins: Array<typeof checkins.$inferSelect>;
  memories: Array<typeof memories.$inferSelect>;
  rejects: Array<typeof auditEvents.$inferSelect>;
  budget: { limitCents: number; spentCents: number; ratio: number };
};

export async function loadCouncilContext(
  userId: string,
  budgetLimitCents: number,
): Promise<CouncilContext> {
  const allAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, userId));
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId));
  const allGoals = await db
    .select()
    .from(goals)
    .where(eq(goals.userId, userId))
    .orderBy(desc(goals.createdAt));
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), gte(tasks.createdAt, since)))
    .orderBy(desc(tasks.createdAt))
    .limit(12);
  const recentCheckins = await db
    .select()
    .from(checkins)
    .where(eq(checkins.userId, userId))
    .orderBy(desc(checkins.date))
    .limit(7);
  const activeMemories = await db
    .select()
    .from(memories)
    .where(and(eq(memories.userId, userId), eq(memories.status, "active")))
    .orderBy(desc(memories.salience))
    .limit(8);
  const recentRejects = await db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.userId, userId),
        eq(auditEvents.action, "audit.reject"),
        gte(auditEvents.createdAt, since),
      ),
    )
    .orderBy(desc(auditEvents.seq))
    .limit(10);

  const [user] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const weekStart = startOfLocalWeek(new Date(), user?.timezone ?? "UTC");
  const spentCents = (
    await Promise.all(
      allAgents.map((agent) => loadSpentCents(agent.id, weekStart)),
    )
  ).reduce((sum, value) => sum + value, 0);

  return {
    agents: allAgents,
    profile,
    goals: allGoals,
    tasks: recentTasks,
    checkins: recentCheckins,
    memories: activeMemories,
    rejects: recentRejects,
    budget: {
      limitCents: budgetLimitCents,
      spentCents,
      ratio:
        budgetLimitCents > 0
          ? Math.min(1, spentCents / budgetLimitCents)
          : 0,
    },
  };
}

export async function assertEvidenceRefs(
  userId: string,
  positions: CouncilPositionDraft[],
): Promise<void> {
  for (const position of positions) {
    const refs = position.evidence
      .map((item) => item.ref)
      .filter((ref): ref is string => Boolean(ref));
    if (refs.length === 0) {
      throw new ValidationError(
        `${position.agentName} must cite at least one evidence ref.`,
      );
    }

    for (const ref of refs) {
      const [kind, ...rest] = ref.split(":");
      const id = rest.join(":");
      if (!kind || !id) {
        throw new ValidationError(`Invalid evidence ref: ${ref}`);
      }

      let found = false;
      if (kind === "goal") {
        const [row] = await db
          .select({ id: goals.id })
          .from(goals)
          .where(and(eq(goals.id, id), eq(goals.userId, userId)))
          .limit(1);
        found = Boolean(row);
      } else if (kind === "task") {
        const [row] = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
          .limit(1);
        found = Boolean(row);
      } else if (kind === "memory") {
        const [row] = await db
          .select({ id: memories.id })
          .from(memories)
          .where(and(eq(memories.id, id), eq(memories.userId, userId)))
          .limit(1);
        found = Boolean(row);
      } else if (kind === "checkin") {
        const [row] = await db
          .select({ id: checkins.id })
          .from(checkins)
          .where(and(eq(checkins.id, id), eq(checkins.userId, userId)))
          .limit(1);
        found = Boolean(row);
      } else if (kind === "agent") {
        const [row] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, id), eq(agents.userId, userId)))
          .limit(1);
        found = Boolean(row);
      } else if (kind === "audit") {
        const [row] = await db
          .select({ id: auditEvents.id })
          .from(auditEvents)
          .where(and(eq(auditEvents.id, id), eq(auditEvents.userId, userId)))
          .limit(1);
        found = Boolean(row);
      } else if (kind === "council") {
        const [row] = await db
          .select({ id: councils.id })
          .from(councils)
          .where(and(eq(councils.id, id), eq(councils.userId, userId)))
          .limit(1);
        found = Boolean(row);
      } else {
        throw new ValidationError(`Unsupported evidence kind: ${kind}`);
      }

      if (!found) {
        throw new ValidationError(`Evidence ref not found: ${ref}`);
      }
    }
  }
}

export function councilConditionForRole(
  role: string,
  config: Awaited<ReturnType<typeof getPolicyConfig>>,
): FalsificationCondition | null {
  if (role === "treasurer") {
    return {
      metric: "budget_spend_cents",
      operator: ">=",
      threshold: Math.round(
        config.budget.weeklyLimitCents * config.council.dissentBudgetRatio,
      ),
      windowDays: config.council.dissentWindowDays,
    };
  }
  if (role === "critic") {
    return {
      metric: "audit_reject_count",
      operator: ">=",
      threshold: Math.max(1, config.audit.rejectStreakLimit),
      windowDays: config.council.dissentWindowDays,
    };
  }
  return null;
}
