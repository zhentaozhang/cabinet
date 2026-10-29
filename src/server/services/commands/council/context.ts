import { and, desc, eq, gte, sql } from "drizzle-orm";
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
import { workspaceBudget } from "@/lib/domain/agent-budget";
import { retrieveMemories } from "@/lib/memory/retrieval";
import { loadWeeklyUsage } from "../tasks/execution";
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
  /**
   * 近 7 天的任务统计。Chief 的 claim 里那句「近 7 天有 N 个任务，M 个已验收」
   * 是统计口径，不能拿展示用的 `tasks`（限 12 条）去数——那样任务一多就常年
   * 停在 12。
   */
  taskStats: { last7d: number; accepted: number };
  /**
   * 工作区这一周的预算视图。额度是按 Agent 分桶的（每桶 min(该 Agent 预算,
   * 策略默认上限)），所以 `limitCents` 是各桶之和，`ratio` 是总和之下的比例；
   * `tightest` 是离自己上限最近的那个 Agent（谁先卡住由它决定）。
   */
  budget: {
    limitCents: number;
    spentCents: number;
    reservedCents: number;
    ratio: number;
    tightest: {
      name: string;
      role: string;
      spentCents: number;
      limitCents: number;
      ratio: number;
    } | null;
  };
};

/** 会议最多带多少条记忆进立场：与检索默认条数一致。 */
export const COUNCIL_MEMORY_LIMIT = 8;

export async function loadCouncilContext(
  userId: string,
  topic: string,
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
    // created_at 相同（同一批建的目标）时再按 id 收一次，否则返回顺序由物理行序决定。
    .orderBy(desc(goals.createdAt), desc(goals.id));
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
  // 议题相关的记忆：走 retrieval.ts 的混合打分（词面命中、3-gram 相似、近因、显著性），
  // 只留真正沾到议题词的条目。原来是「全库显著性最高的 8 条」——议题完全不参与筛选，
  // 但 Researcher 的 claim 写的是「围绕议题找到 N 条相关记忆」，还可能把它们当证据引用：
  // 8 条里一条与议题无关的记忆也能被说成「相关」，并作为该立场的唯一证据。
  // 一条都没沾上时这里为空，Researcher 会如实说没有可引用的历史记忆，证据退回最近任务。
  const retrievedMemories = await retrieveMemories(userId, topic, {
    limit: COUNCIL_MEMORY_LIMIT,
  });
  const activeMemories = retrievedMemories.filter(
    (row) => row.scores.relevance > 0 || row.scores.trigram > 0,
  );
  const [taskStats] = await db
    .select({
      last7d: sql<number>`(count(*))::int`,
      accepted: sql<number>`(count(*) filter (where ${tasks.status} in ('accepted', 'done')))::int`,
    })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), gte(tasks.createdAt, since)));
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
  const timezone = user?.timezone ?? "UTC";
  // The weekly ledger is the only budget authority; reservations are separate.
  const weeklyUsage = await Promise.all(
    allAgents.map((agent) => loadWeeklyUsage(agent.id, timezone)),
  );
  const budgetView = workspaceBudget(weeklyUsage);
  const tightestAgent =
    budgetView.tightest === null
      ? null
      : (allAgents[budgetView.tightest.index] ?? null);
  const reservedCents = weeklyUsage.reduce(
    (sum, usage) => sum + usage.reservedCents,
    0,
  );

  return {
    agents: allAgents,
    profile,
    goals: allGoals,
    tasks: recentTasks,
    checkins: recentCheckins,
    memories: activeMemories,
    rejects: recentRejects,
    taskStats: {
      last7d: taskStats?.last7d ?? 0,
      accepted: taskStats?.accepted ?? 0,
    },
    budget: {
      limitCents: budgetView.limitCents,
      spentCents: budgetView.spentCents,
      reservedCents,
      ratio: budgetView.ratio,
      tightest:
        budgetView.tightest && tightestAgent
          ? {
              name: tightestAgent.name,
              role: tightestAgent.role,
              spentCents: budgetView.tightest.spentCents,
              limitCents: budgetView.tightest.limitCents,
              ratio: budgetView.tightest.ratio,
            }
          : null,
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
