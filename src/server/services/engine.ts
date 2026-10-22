import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentGrants,
  agents,
  approvals,
  artifacts,
  auditEvents,
  checkins,
  councilPositions,
  councils,
  dissents,
  goals,
  insights,
  memories,
  profiles,
  reviews,
  runs,
  skills,
  steps,
  tasks,
  userActions,
  users,
} from "@/lib/db/schema";
import type {
  AcceptanceItem,
  AcceptanceResult,
  CouncilMatrix,
  CouncilResolution,
  Evidence,
  FalsificationCondition,
  ProposedChange,
} from "@/lib/db/schema";
import {
  checklistPassed,
  evaluateAcceptance,
} from "@/lib/domain/acceptance";
import { logAudit } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { weekLabel } from "@/lib/format";
import { generateArtifact } from "@/lib/llm";
import { retrieveMemories } from "@/lib/memory/retrieval";
import { getPolicyConfig } from "@/lib/policy/config";
import {
  buildCouncilMatrix,
  buildCouncilMemo,
  computePositionScores,
  type CouncilPositionDraft,
  type CouncilStance,
} from "@/lib/domain/council";
import { decideAudit, decideRun, decideUpgrade } from "@/lib/domain/policy";
import { assertTransition } from "@/lib/domain/state";
import {
  ConflictError,
  NotFoundError,
  PolicyDenied,
  ValidationError,
} from "@/lib/domain/errors";
import {
  addLocalDays,
  localDateKey,
  startOfLocalWeek,
  weekRange,
} from "@/lib/domain/time";

export async function getWorkspace(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new Error("Demo workspace not seeded. Run `pnpm db:setup`.");
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId));
  return { user, profile };
}

export async function getTodayData(userId: string) {
  const { user, profile } = await getWorkspace(userId);
  const allAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, userId))
    .orderBy(asc(agents.createdAt));
  const allGoals = await db
    .select()
    .from(goals)
    .where(eq(goals.userId, userId));
  const openTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        inArray(tasks.status, [
          "planned",
          "assigned",
          "awaiting_approval",
          "approved",
          "suggested",
          "running",
          "submitted",
          "rejected",
        ]),
      ),
    )
    .orderBy(asc(tasks.dueAt));
  const pendingApprovals = await db
    .select()
    .from(approvals)
    .where(
      and(eq(approvals.userId, userId), eq(approvals.status, "pending")),
    )
    .orderBy(asc(approvals.createdAt));
  const [openCouncil] = await db
    .select()
    .from(councils)
    .where(and(eq(councils.userId, userId), eq(councils.status, "open")))
    .orderBy(desc(councils.createdAt))
    .limit(1);
  const todayKey = localDateKey(new Date(), user.timezone);
  const yesterdayKey = localDateKey(
    addLocalDays(new Date(), -1, user.timezone),
    user.timezone,
  );
  const [todayCheckin] = await db
    .select()
    .from(checkins)
    .where(
      and(eq(checkins.userId, userId), eq(checkins.date, todayKey)),
    )
    .limit(1);
  const [yesterdayCheckin] = await db
    .select()
    .from(checkins)
    .where(
      and(eq(checkins.userId, userId), eq(checkins.date, yesterdayKey)),
    )
    .limit(1);
  const [dailyReview] = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.userId, userId), eq(reviews.type, "daily")))
    .orderBy(desc(reviews.createdAt))
    .limit(1);
  const weeklyMetrics = await getWeeklyMetrics(userId);

  return {
    user,
    profile,
    agents: allAgents,
    goals: allGoals,
    tasks: openTasks,
    approvals: pendingApprovals,
    council: openCouncil ?? null,
    checkin: todayCheckin ?? null,
    yesterdayCheckin: yesterdayCheckin ?? null,
    brief: dailyReview ?? null,
    weeklyMetrics,
  };
}

export async function getCabinetData(userId: string) {
  const { user, profile } = await getWorkspace(userId);
  const allAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, userId))
    .orderBy(asc(agents.createdAt));
  const openTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.userId, userId));
  return { user, profile, agents: allAgents, tasks: openTasks };
}

export async function getAgentData(agentId: string, userId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.userId !== userId) return null;
  const agentRuns = await db
    .select()
    .from(runs)
    .where(eq(runs.agentId, agentId))
    .orderBy(desc(runs.createdAt))
    .limit(10);
  const agentMemories = await db
    .select()
    .from(memories)
    .where(eq(memories.agentId, agentId))
    .orderBy(desc(memories.salience))
    .limit(8);
  const agentSkills = await db
    .select()
    .from(skills)
    .where(eq(skills.agentId, agentId));
  const assigned = await db
    .select()
    .from(tasks)
    .where(eq(tasks.assigneeId, agentId))
    .orderBy(desc(tasks.updatedAt))
    .limit(8);
  return {
    agent,
    runs: agentRuns,
    memories: agentMemories,
    skills: agentSkills,
    tasks: assigned,
  };
}

export async function getTaskData(taskId: string, userId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task || task.userId !== userId) return null;
  const taskRuns = await db
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(asc(runs.createdAt));
  const runIds = taskRuns.map((r) => r.id);
  const runSteps = runIds.length
    ? await db
        .select()
        .from(steps)
        .where(inArray(steps.runId, runIds))
        .orderBy(asc(steps.idx))
    : [];
  const taskArtifacts = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .orderBy(desc(artifacts.createdAt));
  const [goal] = task.goalId
    ? await db.select().from(goals).where(eq(goals.id, task.goalId))
    : [null];
  const [assignee] = task.assigneeId
    ? await db.select().from(agents).where(eq(agents.id, task.assigneeId))
    : [null];
  const [auditor] = task.auditorId
    ? await db.select().from(agents).where(eq(agents.id, task.auditorId))
    : [null];
  const taskApprovals = await db
    .select()
    .from(approvals)
    .where(eq(approvals.taskId, taskId));
  const taskAudit = await db
    .select()
    .from(auditEvents)
    .where(
      and(eq(auditEvents.userId, userId), eq(auditEvents.target, taskId)),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(10);
  return {
    task,
    goal: goal ?? null,
    assignee: assignee ?? null,
    auditor: auditor ?? null,
    runs: taskRuns,
    steps: runSteps,
    artifacts: taskArtifacts,
    approvals: taskApprovals,
    audit: taskAudit,
  };
}

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

export async function getWeeklyMetrics(userId: string) {
  const [user] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId));
  const timezone = user?.timezone ?? "UTC";
  const range = weekRange(new Date(), timezone);
  const config = await getPolicyConfig();
  const now = new Date();
  const endOfToday = addLocalDays(now, 1, timezone);

  const [aaoRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        gte(tasks.acceptedAt, range.start),
        lt(tasks.acceptedAt, range.end),
        gte(tasks.acceptedAutonomyLevel, 2),
      ),
    );

  const [plannedRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        gte(tasks.dueAt, range.start),
        lte(tasks.dueAt, endOfToday),
      ),
    );

  const [completedRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        gte(tasks.dueAt, range.start),
        lte(tasks.dueAt, endOfToday),
        inArray(tasks.status, ["accepted", "done"]),
      ),
    );

  const [costRow] = await db
    .select({
      total: sql<number>`coalesce(sum(${runs.costCents}), 0)`,
    })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(
      and(
        eq(agents.userId, userId),
        gte(runs.createdAt, range.start),
        lt(runs.createdAt, range.end),
      ),
    );

  const [auditRow] = await db
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
    );

  const [actionsRow] = await db
    .select({
      total: sql<number>`coalesce(sum(${userActions.durationMs}), 0)`,
    })
    .from(userActions)
    .where(
      and(
        eq(userActions.userId, userId),
        gte(userActions.createdAt, range.start),
        lt(userActions.createdAt, range.end),
      ),
    );

  const [decisionRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.userId, userId),
        eq(auditEvents.actor, "user"),
        gte(auditEvents.createdAt, range.start),
        lt(auditEvents.createdAt, range.end),
      ),
    );

  const [goal] = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.status, "active")))
    .limit(1);

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

export type MemoryView = "current" | "history";

export async function getMemoryData(
  userId: string,
  type?: string,
  view: MemoryView = "current",
) {
  const all = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        view === "history"
          ? isNotNull(memories.validTo)
          : isNull(memories.validTo),
      ),
    )
    .orderBy(desc(memories.salience));
  const filtered = type ? all.filter((m) => m.type === type) : all;
  const counts = {
    all: all.length,
    episodic: all.filter((m) => m.type === "episodic").length,
    semantic: all.filter((m) => m.type === "semantic").length,
    procedural: all.filter((m) => m.type === "procedural").length,
  };
  const now = Date.now();
  const stale = all.filter(
    (m) => m.expiresAt && new Date(m.expiresAt).getTime() < now,
  ).length;
  return { memories: filtered, counts, stale, view };
}

export async function getCouncilData(userId: string) {
  const [council] = await db
    .select()
    .from(councils)
    .where(eq(councils.userId, userId))
    .orderBy(desc(councils.createdAt))
    .limit(1);
  if (!council) return null;
  const positions = await db
    .select()
    .from(councilPositions)
    .where(eq(councilPositions.councilId, council.id))
    .orderBy(asc(councilPositions.createdAt));
  const allAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, userId));
  return { council, positions, agents: allAgents };
}

function clamp(n: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

function draftFor(
  agentRole: string,
  taskTitle: string,
  priorRuns: number,
  hasRejection = false,
): { title: string; content: string } {
  if (agentRole === "researcher") {
    return {
      title: `${taskTitle} · 资料卡`,
      content: `# ${taskTitle}

## 结论
RAG 的核心不是"把文档塞进 prompt"，而是"召回、重排、约束生成"三件事。

## 证据
1. Retrieval-Augmented Generation for LLMs: A Survey
   https://arxiv.org/abs/2312.10997
2. RAG 的评估应以 recall@k、precision、faithfulness 为主。
   来源：https://arxiv.org/abs/2312.10997

## 不确定
- rerank 的具体延迟取决于模型和批量大小，需要实测。`,
    };
  }

  if (agentRole === "coach" && (taskTitle.includes("评估") || taskTitle.includes("练习"))) {
    const rubric =
      hasRejection
        ? `

## 评分标准（rubric）
| 维度 | 0 分 | 1 分 | 2 分 |
|---|---|---|---|
| 概念准确 | 定义错误 | 定义基本正确 | 定义准确且有例子 |
| 指标理解 | 混淆 recall/precision | 能区分 | 能说明权衡 |
| rerank | 不知道 | 知道用途 | 能说出代价与替代 |
| 评估设计 | 无 | 有题目 | 有题目 + 参考答案 + 评分标准 |

> 总分 ≥6/8 视为通过。`
        : `

> 备注：本版本尚未附评分标准。`;
    return {
      title: `${taskTitle} · v${priorRuns + 1}`,
      content: `# ${taskTitle}

1. recall@k 的定义是什么？举一个检索例子。
2. precision 和 recall 如何权衡？
3. rerank 解决什么问题？代价是什么？
4. 如何构造 20 条问题的评估集？
5. 模型答对但引用错了，算不算成功？

## 参考答案
1. 前 k 个结果中相关文档的比例……
2. 提高 recall 往往引入噪声，precision 下降……
3. rerank 用 cross-encoder 精排，代价是延迟……
4. 从真实问题采样，标注 gold chunk……
5. 不算；引用错误视为幻觉。${rubric}`,
    };
  }

  if (agentRole === "treasurer") {
    return {
      title: `${taskTitle} · 预算表`,
      content: `# 本周学习预算

| 项目 | 金额 | 备注 |
|---|---:|---|
| 课程试学 | ¥199 | 7 天可退 |
| 工具订阅 | ¥0 | 已有 |
| 资料 | ¥81 | 本月剩余 |
| **合计** | **¥280 / ¥600** | 剩余 ¥320 |

## 结论
本周不超支；年包 ¥599 会超支，建议只买月付。`,
    };
  }

  if (agentRole === "auditor") {
    return {
      title: `${taskTitle} · 审计记录`,
      content: `# 审计记录

- 验收标准：已逐条对照
- 证据：已附来源
- 结论：见审计结果`,
    };
  }

  if (agentRole === "apprentice") {
    return {
      title: `${taskTitle} · 技能草案`,
      content: `# 技能草案：检索评估练习设计

## 步骤
1. 读取 mentor 的 5 次成功运行
2. 提取题目结构：定义题 / 对比题 / 场景题
3. 为每题生成参考答案
4. 生成评分标准（rubric）
5. 自检：覆盖 recall / precision / rerank

## 护栏
- 不得编造引用
- 每题必须有评分标准`,
    };
  }

  if (agentRole === "critic") {
    return {
      title: `${taskTitle} · 风险清单`,
      content: `# 风险清单

- 任务粒度仍可能过大
- 评估集只有 5 题，统计意义不足
- 没有留出集，容易过拟合`,
    };
  }

  return {
    title: `${taskTitle} · 计划`,
    content: `# ${taskTitle}

## 本周目标
- 完成检索基础 + chunking
- 每天 25–45 分钟
- 周三晚上不排任务

## 验收
- 每个任务有产物
- 周末能做一次 10 题自测`,
  };
}

async function loadSpentCents(agentId: string, periodStart: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${runs.costCents}), 0)` })
    .from(runs)
    .where(and(eq(runs.agentId, agentId), gte(runs.createdAt, periodStart)));
  return Number(row?.total ?? 0);
}

async function loadLatestApproval(taskId: string) {
  const [row] = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.taskId, taskId),
        inArray(approvals.status, ["pending", "approved"]),
      ),
    )
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  return row ?? null;
}

async function requestApproval(input: {
  userId: string;
  taskId: string;
  action: string;
  reason: string;
  estimatedCostCents: number;
}) {
  const existing = await loadLatestApproval(input.taskId);
  if (existing?.status === "pending") return existing;

  const [created] = await db
    .insert(approvals)
    .values({
      id: newId("appr"),
      userId: input.userId,
      taskId: input.taskId,
      action: input.action,
      payload: {
        taskId: input.taskId,
        actionType: input.action,
        estimatedCostCents: input.estimatedCostCents,
        reason: input.reason,
      },
      status: "pending",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning();
  return created;
}

export async function runTask(taskId: string, userId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task || task.userId !== userId) {
    throw new NotFoundError("Task not found");
  }
  if (!task.assigneeId) throw new ConflictError("Task has no assignee");

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, task.assigneeId));
  if (!agent || agent.userId !== userId) {
    throw new NotFoundError("Agent not found");
  }

  const [user] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, task.userId));
  const timezone = user?.timezone ?? "UTC";
  const config = await getPolicyConfig();
  const grants = await db
    .select()
    .from(agentGrants)
    .where(eq(agentGrants.agentId, agent.id));
  const periodStart =
    agent.budgetPeriodStart ?? startOfLocalWeek(new Date(), timezone);
  const spentCents = await loadSpentCents(agent.id, periodStart);
  const approval = await loadLatestApproval(taskId);

  const decision = decideRun({
    actor: {
      id: agent.id,
      role: agent.role,
      status: agent.status,
      lifecycleStage: agent.lifecycleStage,
      autonomyLevel: agent.autonomyLevel,
      trustScore: agent.trustScore,
      successCount: agent.successCount,
    },
    task: {
      assigneeId: task.assigneeId,
      auditorId: task.auditorId,
      actionType: task.actionType,
      resource: task.resource,
      requiresApproval: task.requiresApproval,
      estimatedCostCents: task.estimatedCostCents,
      approvalThresholdCents: task.approvalThresholdCents,
      status: task.status,
    },
    grants: grants.map((grant) => ({
      resource: grant.resource,
      scope: grant.scope,
    })),
    budget: {
      limitCents: agent.budgetCents,
      spentCents,
    },
    approval: approval
      ? { status: approval.status, consumedAt: approval.consumedAt }
      : null,
    config,
  });

  if (decision.effect === "deny") {
    throw new PolicyDenied(decision.reason);
  }

  const prior = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.taskId, taskId));

  if (decision.effect === "suggest") {
    const [updated] = await db
      .update(tasks)
      .set({ status: "suggested", updatedAt: new Date() })
      .where(
        and(
          eq(tasks.id, taskId),
          inArray(tasks.status, ["planned", "assigned"]),
        ),
      )
      .returning();
    if (!updated) throw new ConflictError("Task cannot be suggested now.");

    const runId = newId("run");
    const draft = draftFor(agent.role, task.title, prior.length, false);
    const artifactId = newId("art");
    await db.insert(runs).values({
      id: runId,
      taskId,
      agentId: agent.id,
      status: "succeeded",
      mode: "demo",
      startedAt: new Date(),
      endedAt: new Date(),
      replayKey: `suggest_${taskId}_${prior.length + 1}`,
    });
    await db.insert(artifacts).values({
      id: artifactId,
      runId,
      taskId,
      type: "markdown",
      title: draft.title,
      content: draft.content,
    });
    await db.insert(steps).values({
      id: newId("stp"),
      runId,
      idx: 1,
      type: "suggest",
      input: { task: task.title, policy: decision.reason },
      output: { artifactId },
      tokensIn: 120,
      tokensOut: 240,
      latencyMs: 80,
    });
    await logAudit({
      userId: task.userId,
      actor: `agent:${agent.id}`,
      action: "task.suggest",
      target: taskId,
      before: { status: task.status },
      after: { status: "suggested", runId, reason: decision.reason },
    });
    return { runId, artifactId, suggested: true, reason: decision.reason };
  }

  if (decision.effect === "require_approval") {
    const approvalRecord = await requestApproval({
      userId: task.userId,
      taskId,
      action: task.actionType,
      reason: decision.reason,
      estimatedCostCents: task.estimatedCostCents,
    });

    if (task.status !== "awaiting_approval") {
      assertTransition("task", task.status, "awaiting_approval");
      const [updated] = await db
        .update(tasks)
        .set({ status: "awaiting_approval", updatedAt: new Date() })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, task.status)))
        .returning();
      if (!updated) throw new ConflictError("Task state changed; retry.");
    }

    await logAudit({
      userId: task.userId,
      actor: `agent:${agent.id}`,
      action: "approval.request",
      target: taskId,
      before: { status: task.status },
      after: { status: "awaiting_approval", approvalId: approvalRecord.id },
    });

    return {
      requiresApproval: true,
      approvalId: approvalRecord.id,
      reason: decision.reason,
    };
  }

  const runId = newId("run");
  const startedAt = new Date();
  await db.transaction(async (tx) => {
    let status = task.status;
    if (status === "planned") {
      assertTransition("task", status, "assigned");
      const [assigned] = await tx
        .update(tasks)
        .set({ status: "assigned", updatedAt: new Date() })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, "planned")))
        .returning();
      if (!assigned) throw new ConflictError("Task state changed; retry.");
      status = "assigned";
    }

    assertTransition("task", status, "running");
    const [running] = await tx
      .update(tasks)
      .set({ status: "running", updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, status)))
      .returning();
    if (!running) throw new ConflictError("Task state changed; retry.");

    if (approval?.status === "approved" && !approval.consumedAt) {
      const [consumed] = await tx
        .update(approvals)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(approvals.id, approval.id),
            eq(approvals.status, "approved"),
            isNull(approvals.consumedAt),
          ),
        )
        .returning();
      if (!consumed) throw new ConflictError("Approval already consumed.");
    }

    await tx.insert(runs).values({
      id: runId,
      taskId,
      agentId: agent.id,
      status: "running",
      mode: process.env.OPENAI_API_KEY ? "live" : "demo",
      startedAt,
      replayKey: `replay_${taskId}_${prior.length + 1}`,
    });
  });

  let idx = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const addStep = async (input: {
    type: string;
    tool?: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    ti?: number;
    to?: number;
    latency?: number;
  }) => {
    idx += 1;
    tokensIn += input.ti ?? 0;
    tokensOut += input.to ?? 0;
    await db.insert(steps).values({
      id: newId("stp"),
      runId,
      idx,
      type: input.type,
      tool: input.tool ?? null,
      input: input.input,
      output: input.output,
      tokensIn: input.ti ?? 0,
      tokensOut: input.to ?? 0,
      latencyMs: input.latency ?? 120,
    });
  };

  try {
    const agentMemories = await retrieveMemories(
      task.userId,
      `${task.title} ${task.description}`,
      { limit: 5 },
    );

    await addStep({
      type: "context",
      input: { task: task.title, agent: agent.name },
      output: {
        memories: agentMemories.map((m) => m.content),
        retrieved: agentMemories.map((m) => ({
          id: m.id,
          content: m.content,
          scores: m.scores,
        })),
        goal: task.goalId,
      },
      ti: 220,
      latency: 90,
    });

    await addStep({
      type: "plan",
      input: { estimateMin: task.estimateMin },
      output: {
        steps: ["读取上下文", "执行", "产出草稿", "提交验收"],
        strategy: agent.role === "chief" ? "拆解与派活" : "单任务执行",
      },
      ti: 380,
      to: 180,
      latency: 700,
    });

    const tool =
      agent.role === "researcher"
        ? "web_search"
        : agent.role === "coach"
          ? "read_notes"
          : agent.role === "treasurer"
            ? "ledger_read"
            : agent.role === "auditor"
              ? "read_artifacts"
              : "read_notes";

    await addStep({
      type: "tool",
      tool,
      input: { query: task.title },
      output: {
        result:
          agent.role === "researcher"
            ? "3 条结果，已抓取 1 篇"
            : "命中 2 条相关记忆",
      },
      ti: 180,
      to: 80,
      latency: 600,
    });

    const [priorRejection] = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.target, taskId),
          eq(auditEvents.action, "audit.reject"),
        ),
      )
      .limit(1);

    const generated = await generateArtifact({
      agentName: agent.name,
      role: agent.role,
      charter: agent.charter,
      taskTitle: task.title,
      taskDescription: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      memories: agentMemories.map((m) => m.content),
    });
    const draft =
      generated ??
      draftFor(agent.role, task.title, prior.length, Boolean(priorRejection));
    const artifactId = newId("art");

    await addStep({
      type: "draft",
      input: { format: "markdown", mode: generated ? "live" : "demo" },
      output: { artifactId, title: draft.title },
      ti: generated ? generated.tokensIn : 500,
      to: generated ? generated.tokensOut : 600,
      latency: generated ? 2400 : 1100,
    });

    await addStep({
      type: "submit",
      input: { auditor: task.auditorId },
      output: { status: "submitted" },
      ti: 40,
      to: 20,
      latency: 40,
    });

    const cost = Number(
      (((tokensIn + tokensOut) / 1000) * config.cost.centsPer1kTokens).toFixed(
        2,
      ),
    );

    await db.transaction(async (tx) => {
      await tx.insert(artifacts).values({
        id: artifactId,
        runId,
        taskId,
        type: "markdown",
        title: draft.title,
        content: draft.content,
      });

      const [submitted] = await tx
        .update(tasks)
        .set({ status: "submitted", updatedAt: new Date() })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, "running")))
        .returning();
      if (!submitted) throw new ConflictError("Task is not running anymore.");

      await tx
        .update(runs)
        .set({
          status: "succeeded",
          endedAt: new Date(),
          costCents: cost,
          tokensIn,
          tokensOut,
        })
        .where(eq(runs.id, runId));

      await tx
        .update(agents)
        .set({ spentCents: sql`${agents.spentCents} + ${cost}` })
        .where(eq(agents.id, agent.id));
    });

    await logAudit({
      userId: task.userId,
      actor: `agent:${agent.id}`,
      action: "task.submit",
      target: taskId,
      before: { status: "running" },
      after: { status: "submitted", runId },
    });

    return { runId, artifactId };
  } catch (error) {
    await db
      .update(runs)
      .set({
        status: "failed",
        endedAt: new Date(),
        error: error instanceof Error ? error.message : "run failed",
      })
      .where(eq(runs.id, runId));
    await db
      .update(tasks)
      .set({ status: "failed", updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "running")));
    await logAudit({
      userId: task.userId,
      actor: `agent:${agent.id}`,
      action: "task.run.failed",
      target: taskId,
      before: { status: "running" },
      after: {
        status: "failed",
        error: error instanceof Error ? error.message : "run failed",
      },
    });
    throw error;
  }
}

export async function promoteSuggestion(taskId: string, userId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task || task.userId !== userId) {
    throw new NotFoundError("Task not found");
  }
  if (task.status !== "suggested") {
    throw new ConflictError(`Task is ${task.status}, not a suggestion.`);
  }
  assertTransition("task", "suggested", "planned");
  const [updated] = await db
    .update(tasks)
    .set({ status: "planned", updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "suggested")))
    .returning();
  if (!updated) throw new ConflictError("Task state changed; retry.");

  await logAudit({
    userId: task.userId,
    actor: "user",
    action: "task.promote",
    target: taskId,
    before: { status: "suggested" },
    after: { status: "planned" },
  });

  return updated;
}

export async function auditTask(taskId: string, userId: string) {
  try {
    return await auditTaskInner(taskId, userId);
  } catch (error) {
    await db
      .update(tasks)
      .set({ status: "submitted", updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "auditing")));
    throw error;
  }
}

async function auditTaskInner(taskId: string, userId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task || task.userId !== userId) {
    throw new NotFoundError("Task not found");
  }
  if (!task.auditorId) throw new ConflictError("Task has no auditor");
  const [auditor] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, task.auditorId));
  if (!auditor || auditor.userId !== userId) {
    throw new NotFoundError("Auditor not found");
  }

  const config = await getPolicyConfig();
  const auditDecision = decideAudit({
    actor: {
      id: auditor.id,
      role: auditor.role,
      status: auditor.status,
      lifecycleStage: auditor.lifecycleStage,
      autonomyLevel: auditor.autonomyLevel,
      trustScore: auditor.trustScore,
      successCount: auditor.successCount,
    },
    task: {
      assigneeId: task.assigneeId,
      auditorId: task.auditorId,
      actionType: task.actionType,
      resource: task.resource,
      requiresApproval: task.requiresApproval,
      estimatedCostCents: task.estimatedCostCents,
      approvalThresholdCents: task.approvalThresholdCents,
      status: task.status,
    },
  });
  if (auditDecision.effect === "deny") {
    throw new PolicyDenied(auditDecision.reason);
  }

  assertTransition("task", task.status, "auditing");
  const [locked] = await db
    .update(tasks)
    .set({ status: "auditing", updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "submitted")))
    .returning();
  if (!locked) throw new ConflictError("Task is not submitted for audit.");

  const taskRuns = await db
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.createdAt));
  const [artifact] = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .orderBy(desc(artifacts.createdAt))
    .limit(1);

  const runId = newId("run");
  await db.insert(runs).values({
    id: runId,
    taskId,
    agentId: auditor.id,
    status: "running",
    mode: "demo",
    startedAt: new Date(),
    replayKey: `audit_${taskId}_${taskRuns.length + 1}`,
  });

  let idx = 0;
  const addStep = async (input: {
    type: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
  }) => {
    idx += 1;
    await db.insert(steps).values({
      id: newId("stp"),
      runId,
      idx,
      type: input.type,
      input: input.input,
      output: input.output,
      tokensIn: 80,
      tokensOut: 40,
      latencyMs: 100,
    });
  };

  await addStep({
    type: "context",
    input: { task: taskId, artifact: artifact?.id ?? null },
    output: { found: Boolean(artifact) },
  });

  let pass = Boolean(artifact);
  let reason = pass
    ? "产物存在，验收标准逐条对照通过。"
    : "没有找到可验收的产物。";
  let acceptanceReport: AcceptanceResult[] | null = null;

  if (artifact && task.acceptanceChecklist?.length) {
    acceptanceReport = evaluateAcceptance(
      artifact.content,
      task.acceptanceChecklist,
    );
    pass = checklistPassed(acceptanceReport);
    const failed = acceptanceReport.filter(
      (result) => result.item.required && !result.passed,
    );
    reason = pass
      ? "验收清单逐项通过。"
      : `验收清单未通过：${failed
          .map((result) => result.reason)
          .join("；")}`;
  } else if (artifact) {
    const requiresRubric =
      task.acceptanceCriteria.includes("评分标准") ||
      task.acceptanceCriteria.toLowerCase().includes("rubric");
    if (requiresRubric) {
      const hasRubric =
        artifact.content.includes("## 评分标准") ||
        artifact.content.includes("| 维度 |");
      if (!hasRubric) {
        pass = false;
        reason = "缺少评分标准（rubric），无法判断题目质量。请补充后重新提交。";
      }
    }
  }

  await addStep({
    type: "audit",
    input: {
      acceptanceCriteria: task.acceptanceCriteria,
      checklist: task.acceptanceChecklist ?? null,
    },
    output: { pass, reason, checklist: acceptanceReport },
  });

  await db
    .update(runs)
    .set({
      status: "succeeded",
      endedAt: new Date(),
      costCents: 0.4,
      tokensIn: 160,
      tokensOut: 80,
    })
    .where(eq(runs.id, runId));

  const nextStatus = pass ? "accepted" : "rejected";
  const executor = task.assigneeId
    ? ((await db
        .select()
        .from(agents)
        .where(eq(agents.id, task.assigneeId)))[0] ?? null)
    : null;

  const [decided] = await db
    .update(tasks)
    .set({
      status: nextStatus,
      acceptanceReport,
      updatedAt: new Date(),
      ...(pass
        ? {
            acceptedAt: new Date(),
            acceptedAutonomyLevel: executor?.autonomyLevel ?? null,
          }
        : {}),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "auditing")))
    .returning();
  if (!decided) throw new ConflictError("Task left the auditing state.");

  if (executor) {
    const nextRejectStreak = pass ? 0 : executor.rejectStreak + 1;
    const shouldPause =
      !pass &&
      nextRejectStreak >= config.audit.rejectStreakLimit &&
      ["active", "probation"].includes(executor.status);

    if (shouldPause) {
      assertTransition("agent", executor.status, "paused");
    }

    await db
      .update(agents)
      .set({
        successCount: executor.successCount + (pass ? 1 : 0),
        failCount: executor.failCount + (pass ? 0 : 1),
        trustScore: clamp(executor.trustScore + (pass ? 1 : -2)),
        rejectStreak: nextRejectStreak,
        ...(shouldPause ? { status: "paused" } : {}),
      })
      .where(eq(agents.id, executor.id));

    if (shouldPause) {
      await logAudit({
        userId: task.userId,
        actor: "system",
        action: "agent.paused",
        target: executor.id,
        before: {
          status: executor.status,
          rejectStreak: executor.rejectStreak,
        },
        after: {
          status: "paused",
          rejectStreak: nextRejectStreak,
          reason: "reject_streak_limit",
        },
      });
    }
  }

  if (pass && task.goalId) {
    const [goal] = await db.select().from(goals).where(eq(goals.id, task.goalId));
    if (goal) {
      await db
        .update(goals)
        .set({ progress: clamp(goal.progress + 2, 0, 100) })
        .where(eq(goals.id, goal.id));
    }
  }

  await logAudit({
    userId: task.userId,
    actor: `agent:${auditor.id}`,
    action: pass ? "audit.accept" : "audit.reject",
    target: taskId,
    before: { status: "auditing" },
    after: { status: nextStatus, reason },
  });

  return { decision: pass ? "accepted" : "rejected", reason, runId };
}

export async function decideApproval(
  approvalId: string,
  decision: "approve" | "reject",
  reason: string | undefined,
  userId: string,
) {
  const [approval] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId));
  if (!approval || approval.userId !== userId) {
    throw new NotFoundError("Approval not found");
  }
  if (approval.status !== "pending") {
    throw new ConflictError(`Approval is already ${approval.status}.`);
  }

  const [updated] = await db
    .update(approvals)
    .set({
      status: decision === "approve" ? "approved" : "rejected",
      reason: reason ?? null,
      decidedAt: new Date(),
    })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
    .returning();
  if (!updated) throw new ConflictError("Approval state changed; retry.");

  if (approval.taskId) {
    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, approval.taskId));
    if (task) {
      const target = decision === "approve" ? "approved" : "cancelled";
      assertTransition("task", task.status, target);
      const [taskUpdated] = await db
        .update(tasks)
        .set({ status: target, updatedAt: new Date() })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)))
        .returning();
      if (!taskUpdated) throw new ConflictError("Task state changed; retry.");
    }
  }

  await logAudit({
    userId: approval.userId,
    actor: "user",
    action: decision === "approve" ? "approval.grant" : "approval.deny",
    target: approval.id,
    before: { status: "pending" },
    after: { status: decision, reason: reason ?? null },
  });
}

export async function decideCouncil(
  councilId: string,
  decision: "approve" | "reject" | "conditions",
  note: string,
  userId: string,
) {
  const [council] = await db
    .select()
    .from(councils)
    .where(and(eq(councils.id, councilId), eq(councils.userId, userId)));
  if (!council) {
    throw new NotFoundError("Council not found");
  }
  if (council.status !== "open") {
    throw new ConflictError(`Council is already ${council.status}.`);
  }

  const positions = await db
    .select()
    .from(councilPositions)
    .where(eq(councilPositions.councilId, councilId))
    .orderBy(asc(councilPositions.createdAt));

  const allAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, userId));
  const chief = allAgents.find((agent) => agent.role === "chief");
  const auditor = allAgents.find((agent) => agent.role === "auditor");
  const config = await getPolicyConfig();

  const label =
    decision === "approve"
      ? "批准"
      : decision === "reject"
        ? "否决"
        : "有条件批准";
  const trimmedNote = note.trim();

  const dissentRecords = positions
    .filter((position) => position.isDissent || position.stance === "oppose")
    .map((position) => ({
      agentId: position.agentId,
      claim: position.claim,
      risk: position.risk,
      recommendation: position.recommendation,
    }));

  let taskId: string | null = null;
  let memoryId: string | null = null;
  const dissentIds: string[] = [];
  let updated: typeof council;

  await db.transaction(async (tx) => {
    const [locked] = await tx
      .update(councils)
      .set({ status: "decided", decidedAt: new Date() })
      .where(and(eq(councils.id, councilId), eq(councils.status, "open")))
      .returning();
    if (!locked) throw new ConflictError("Council state changed; retry.");

    if (decision !== "reject") {
      if (!chief || !auditor) {
        throw new ValidationError(
          "Approved councils need both a Chief and an Auditor.",
        );
      }
      taskId = newId("tsk");
      const acceptance =
        decision === "conditions" && trimmedNote
          ? `按内阁条件执行：${trimmedNote}`
          : `完成内阁决议并附执行证据：${council.topic}`;
      await tx.insert(tasks).values({
        id: taskId,
        userId,
        title: `执行内阁决议：${council.topic}`,
        description: `内阁于 ${new Date().toISOString()} ${label}：${trimmedNote || "无附加说明"}`,
        assigneeId: chief.id,
        auditorId: auditor.id,
        status: "planned",
        priority: 1,
        acceptanceCriteria: acceptance,
        estimateMin: 25,
        actionType: "internal_write",
        resource: "task",
        estimatedCostCents: 0,
        createdBy: "user",
      });
    }

    memoryId = newId("mem");
    await tx.insert(memories).values({
      id: memoryId,
      userId,
      type: "procedural",
      domain: "council",
      content: `内阁决议（${label}）：${council.topic}。${trimmedNote || "无附加说明"}`,
      confidence: 0.8,
      salience: 0.8,
      evidence: [
        {
          label: "内阁决议",
          ref: `council:${councilId}`,
          quote: trimmedNote || label,
        },
      ],
      sourceEventId: councilId,
      lastConfirmedAt: new Date(),
      status: "active",
    });

    if (decision !== "reject") {
      for (const dissent of dissentRecords) {
        const position = positions.find(
          (candidate) => candidate.agentId === dissent.agentId,
        );
        const role =
          allAgents.find((candidate) => candidate.id === dissent.agentId)
            ?.role ?? "";
        const condition =
          position?.falsificationCondition ??
          councilConditionForRole(role, config) ?? {
            metric: "audit_reject_count" as const,
            operator: ">=" as const,
            threshold: Math.max(1, config.audit.rejectStreakLimit),
            windowDays: config.council.dissentWindowDays,
          };
        const dissentId = newId("dis");
        await tx.insert(dissents).values({
          id: dissentId,
          userId,
          councilId,
          taskId,
          agentId: dissent.agentId,
          warning: dissent.risk || dissent.claim,
          condition,
          status: "pending",
          evidence: position?.evidence ?? [],
        });
        dissentIds.push(dissentId);
      }
    }

    const resolution: CouncilResolution = {
      decision,
      note: trimmedNote,
      taskId,
      memoryId,
      dissents: dissentRecords,
      decidedAt: new Date().toISOString(),
    };

    const [withResolution] = await tx
      .update(councils)
      .set({
        memo: `${locked.memo}\n\n## 决定\n${label}：${trimmedNote || "无附加说明"}\n\n## 落地\n${
          taskId ? `已生成跟进任务 ${taskId}` : "未生成任务"
        }；已写入程序记忆 ${memoryId}。`,
        resolution,
        resolutionAppliedAt: new Date(),
      })
      .where(eq(councils.id, councilId))
      .returning();

    updated = withResolution;
  });

  await logAudit({
    userId: council.userId,
    actor: "user",
    action: "council.decide",
    target: councilId,
    before: { status: "open" },
    after: {
      status: "decided",
      decision,
      note: trimmedNote,
      taskId,
      memoryId,
      dissents: dissentRecords,
      dissentIds,
    },
  });

  return updated!;
}

export async function setAutonomy(agentId: string, level: number, userId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.userId !== userId) {
    throw new NotFoundError("Agent not found");
  }
  if (level < 0 || level > 4) throw new ConflictError("Invalid autonomy level");

  const config = await getPolicyConfig();
  const auditRows = await db
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .innerJoin(tasks, eq(tasks.id, auditEvents.target))
    .where(
      and(
        eq(tasks.assigneeId, agentId),
        inArray(auditEvents.action, ["audit.accept", "audit.reject"]),
      ),
    )
    .orderBy(desc(auditEvents.seq))
    .limit(config.audit.passRateWindow);

  const accepts = auditRows.filter(
    (row) => row.action === "audit.accept",
  ).length;
  const auditPassRate =
    auditRows.length > 0 ? accepts / auditRows.length : 0;

  const decision = decideUpgrade({
    actor: {
      id: agent.id,
      role: agent.role,
      status: agent.status,
      lifecycleStage: agent.lifecycleStage,
      autonomyLevel: agent.autonomyLevel,
      trustScore: agent.trustScore,
      successCount: agent.successCount,
    },
    targetLevel: level,
    auditPassRate,
    config,
  });

  if (decision.effect === "deny") {
    throw new PolicyDenied(decision.reason);
  }

  const [updated] = await db
    .update(agents)
    .set({ autonomyLevel: level })
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.autonomyLevel, agent.autonomyLevel),
      ),
    )
    .returning();
  if (!updated) throw new ConflictError("Agent autonomy changed; retry.");

  await logAudit({
    userId: agent.userId,
    actor: "user",
    action: "autonomy.change",
    target: agentId,
    before: { level: agent.autonomyLevel },
    after: { level, auditPassRate, reason: decision.reason },
  });

  return { level, auditPassRate };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function factSlug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "rule"
  );
}

function factForChange(
  change: ProposedChange,
): { factKey: string; value: string } | null {
  if (change.type === "reschedule" && change.taskId) {
    return { factKey: `schedule:${change.taskId}`, value: change.to };
  }
  if (change.type === "split_task" && change.taskId) {
    return {
      factKey: `task:${change.taskId}:split`,
      value: String(change.minutes),
    };
  }
  if (change.type === "add_rule") {
    return { factKey: `rule:${factSlug(change.rule)}`, value: change.rule };
  }
  return null;
}

async function writeMemoryFact(
  tx: Tx,
  input: {
    userId: string;
    agentId: string;
    type: "semantic" | "procedural";
    domain: string;
    content: string;
    confidence: number;
    salience: number;
    evidence: Evidence[];
    sourceEventId: string;
    factKey: string | null;
    value: string | null;
  },
): Promise<string> {
  const now = new Date();
  if (input.factKey) {
    const [existing] = await tx
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, input.userId),
          eq(memories.factKey, input.factKey),
          isNull(memories.validTo),
        ),
      )
      .orderBy(desc(memories.validFrom))
      .limit(1);

    if (existing) {
      if (existing.value === input.value) {
        await tx
          .update(memories)
          .set({ lastConfirmedAt: now })
          .where(eq(memories.id, existing.id));
        return existing.id;
      }

      const nextId = newId("mem");
      await tx
        .update(memories)
        .set({
          validTo: now,
          supersededBy: nextId,
          status: "superseded",
        })
        .where(eq(memories.id, existing.id));
      await tx.insert(memories).values({
        id: nextId,
        userId: input.userId,
        agentId: input.agentId,
        type: input.type,
        domain: input.domain,
        content: input.content,
        factKey: input.factKey,
        value: input.value,
        validFrom: now,
        confidence: input.confidence,
        salience: input.salience,
        evidence: input.evidence,
        sourceEventId: input.sourceEventId,
        lastConfirmedAt: now,
        status: "active",
      });
      return nextId;
    }
  }

  const id = newId("mem");
  await tx.insert(memories).values({
    id,
    userId: input.userId,
    agentId: input.agentId,
    type: input.type,
    domain: input.domain,
    content: input.content,
    factKey: input.factKey,
    value: input.value,
    validFrom: now,
    confidence: input.confidence,
    salience: input.salience,
    evidence: input.evidence,
    sourceEventId: input.sourceEventId,
    lastConfirmedAt: now,
    status: "active",
  });
  return id;
}

async function applyChange(
  tx: Tx,
  change: {
    type: string;
    taskId?: string;
    to?: string;
    minutes?: number;
    rule?: string;
  },
  userId: string,
): Promise<{
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}> {
  if (change.type === "reschedule" && change.taskId && change.to) {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, change.taskId));
    if (!task) throw new NotFoundError("Task not found");
    const [h, m] = change.to.split(":").map(Number);
    const next = new Date();
    next.setHours(h, m, 0, 0);
    await tx
      .update(tasks)
      .set({ dueAt: next, updatedAt: new Date() })
      .where(eq(tasks.id, change.taskId));
    return {
      before: { dueAt: task.dueAt ? task.dueAt.toISOString() : null },
      after: { dueAt: next.toISOString() },
    };
  }

  if (change.type === "split_task" && change.taskId && change.minutes) {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, change.taskId));
    if (!task) throw new NotFoundError("Task not found");
    await tx
      .update(tasks)
      .set({ estimateMin: change.minutes, updatedAt: new Date() })
      .where(eq(tasks.id, change.taskId));
    return {
      before: { estimateMin: task.estimateMin },
      after: { estimateMin: change.minutes },
    };
  }

  if (change.type === "add_rule" && change.rule) {
    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId));
    const preferences = (profile?.preferences ?? {}) as Record<string, unknown>;
    const beforeRules = Array.isArray(preferences.rules)
      ? ([...preferences.rules] as string[])
      : [];
    const nextRules = beforeRules.includes(change.rule)
      ? beforeRules
      : [...beforeRules, change.rule];
    await tx
      .update(profiles)
      .set({
        preferences: { ...preferences, rules: nextRules },
        updatedAt: new Date(),
      })
      .where(eq(profiles.userId, userId));
    return {
      before: { rules: beforeRules },
      after: { rules: nextRules },
    };
  }

  return { before: null, after: null };
}

async function reverseChange(
  tx: Tx,
  change: {
    type: string;
    taskId?: string;
    from?: string;
    rule?: string;
  },
  userId: string,
  beforeState: Record<string, unknown> | null,
): Promise<void> {
  if (!beforeState) {
    throw new ConflictError(
      "This insight has no stored rollback state; cannot roll back safely.",
    );
  }

  if (change.type === "reschedule" && change.taskId) {
    const dueAt = beforeState.dueAt;
    if (typeof dueAt !== "string") {
      throw new ConflictError("Rollback state is missing dueAt.");
    }
    await tx
      .update(tasks)
      .set({ dueAt: new Date(dueAt), updatedAt: new Date() })
      .where(eq(tasks.id, change.taskId));
    return;
  }

  if (change.type === "split_task" && change.taskId) {
    const estimateMin = beforeState.estimateMin;
    if (typeof estimateMin !== "number") {
      throw new ConflictError("Rollback state is missing estimateMin.");
    }
    await tx
      .update(tasks)
      .set({ estimateMin, updatedAt: new Date() })
      .where(eq(tasks.id, change.taskId));
    return;
  }

  if (change.type === "add_rule") {
    const rules = beforeState.rules;
    if (!Array.isArray(rules)) {
      throw new ConflictError("Rollback state is missing rules.");
    }
    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId));
    const preferences = (profile?.preferences ?? {}) as Record<string, unknown>;
    await tx
      .update(profiles)
      .set({
        preferences: { ...preferences, rules },
        updatedAt: new Date(),
      })
      .where(eq(profiles.userId, userId));
  }
}

export async function updateAgent(
  agentId: string,
  input: {
    status?: "active" | "paused" | "retired";
    charter?: string;
    budgetCents?: number;
  },
  userId: string,
) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.userId !== userId) {
    throw new NotFoundError("Agent not found");
  }

  const nextStatus = input.status ?? agent.status;
  if (input.status && input.status !== agent.status) {
    assertTransition("agent", agent.status, input.status);
    if (input.status === "retired") {
      const [openRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(
          and(
            eq(tasks.assigneeId, agentId),
            inArray(tasks.status, [
              "planned",
              "assigned",
              "awaiting_approval",
              "approved",
              "running",
              "submitted",
              "auditing",
              "rejected",
              "suggested",
            ]),
          ),
        );
      if (Number(openRow?.count ?? 0) > 0) {
        throw new ConflictError(
          "Reassign open tasks before retiring this agent.",
        );
      }
    }
  }

  if (input.charter !== undefined && input.charter.trim().length < 20) {
    throw new ValidationError("Charter must be at least 20 characters.");
  }

  if (
    input.budgetCents !== undefined &&
    (!Number.isInteger(input.budgetCents) || input.budgetCents < 0)
  ) {
    throw new ValidationError("Budget must be a non-negative integer.");
  }

  const [updated] = await db
    .update(agents)
    .set({
      ...(input.status ? { status: nextStatus } : {}),
      ...(input.charter !== undefined ? { charter: input.charter.trim() } : {}),
      ...(input.budgetCents !== undefined
        ? { budgetCents: input.budgetCents }
        : {}),
    })
    .where(and(eq(agents.id, agentId), eq(agents.status, agent.status)))
    .returning();
  if (!updated) throw new ConflictError("Agent state changed; retry.");

  await logAudit({
    userId: agent.userId,
    actor: "user",
    action: "agent.update",
    target: agentId,
    before: {
      status: agent.status,
      charter: agent.charter,
      budgetCents: agent.budgetCents,
    },
    after: {
      status: updated.status,
      charter: updated.charter,
      budgetCents: updated.budgetCents,
    },
  });

  return updated;
}

export async function createGoal(
  input: {
    title: string;
    why: string;
    target: string;
    horizon: string;
    domain: string;
  },
  userId: string,
) {
  const title = input.title.trim();
  const why = input.why.trim();
  const target = input.target.trim();
  const horizon = input.horizon.trim();
  const domain = input.domain.trim();
  if (!title || !why || !target || !horizon || !domain) {
    throw new ValidationError("All goal fields are required.");
  }

  const id = newId("goal");
  const [created] = await db
    .insert(goals)
    .values({
      id,
      userId: userId,
      domain,
      title,
      why,
      target,
      horizon,
      status: "active",
      progress: 0,
    })
    .returning();

  await logAudit({
    userId: userId,
    actor: "user",
    action: "goal.create",
    target: id,
    before: null,
    after: { title, domain, horizon },
  });

  return created;
}

export async function createTask(
  input: {
    goalId?: string | null;
    title: string;
    description: string;
    assigneeId: string;
    auditorId: string;
    actionType: string;
    resource: string;
    estimatedCostCents: number;
    acceptanceCriteria: string;
    acceptanceChecklist?: AcceptanceItem[] | null;
    estimateMin: number;
    dueAt?: string | null;
  },
  userId: string,
) {
  const title = input.title.trim();
  const description = input.description.trim();
  const acceptanceCriteria = input.acceptanceCriteria.trim();
  if (!title || !description || !acceptanceCriteria) {
    throw new ValidationError("Title, description and criteria are required.");
  }
  if (input.assigneeId === input.auditorId) {
    throw new ValidationError("Assignee and auditor must differ.");
  }

  const [assignee] = await db
    .select({ id: agents.id, userId: agents.userId })
    .from(agents)
    .where(eq(agents.id, input.assigneeId));
  const [auditor] = await db
    .select({ id: agents.id, userId: agents.userId })
    .from(agents)
    .where(eq(agents.id, input.auditorId));
  if (
    !assignee ||
    !auditor ||
    assignee.userId !== userId ||
    auditor.userId !== userId
  ) {
    throw new ValidationError("Assignee or auditor not found.");
  }

  if (input.goalId) {
    const [goal] = await db
      .select({ id: goals.id, userId: goals.userId })
      .from(goals)
      .where(eq(goals.id, input.goalId));
    if (!goal || goal.userId !== userId) {
      throw new ValidationError("Goal not found.");
    }
  }

  const dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (dueAt && Number.isNaN(dueAt.getTime())) {
    throw new ValidationError("Invalid due date.");
  }

  const id = newId("tsk");
  const [created] = await db
    .insert(tasks)
    .values({
      id,
      userId: userId,
      goalId: input.goalId ?? null,
      title,
      description,
      assigneeId: input.assigneeId,
      auditorId: input.auditorId,
      status: "planned",
      priority: 2,
      dueAt,
      acceptanceCriteria,
      acceptanceChecklist: input.acceptanceChecklist ?? null,
      estimateMin: Math.max(1, input.estimateMin),
      actionType: input.actionType,
      resource: input.resource,
      estimatedCostCents: Math.max(0, input.estimatedCostCents),
      createdBy: "user",
    })
    .returning();

  await logAudit({
    userId: userId,
    actor: "user",
    action: "task.create",
    target: id,
    before: null,
    after: {
      title,
      assigneeId: input.assigneeId,
      auditorId: input.auditorId,
      actionType: input.actionType,
      resource: input.resource,
    },
  });

  return created;
}

type CouncilContext = {
  agents: Array<typeof agents.$inferSelect>;
  profile: typeof profiles.$inferSelect | undefined;
  goals: Array<typeof goals.$inferSelect>;
  tasks: Array<typeof tasks.$inferSelect>;
  checkins: Array<typeof checkins.$inferSelect>;
  memories: Array<typeof memories.$inferSelect>;
  rejects: Array<typeof auditEvents.$inferSelect>;
  budget: { limitCents: number; spentCents: number; ratio: number };
};

async function loadCouncilContext(
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
  const recentTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.userId, userId))
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
      ),
    )
    .orderBy(desc(auditEvents.seq))
    .limit(10);

  const spentCents = allAgents.reduce(
    (sum, agent) => sum + Number(agent.spentCents ?? 0),
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

async function assertEvidenceRefs(
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

function councilConditionForRole(
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

function short(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function buildCouncilPosition(input: {
  role: "chief" | "researcher" | "coach" | "treasurer" | "critic";
  context: CouncilContext;
  config: Awaited<ReturnType<typeof getPolicyConfig>>;
}): CouncilPositionDraft | null {
  const { role, context, config } = input;
  const agent = context.agents.find((candidate) => candidate.role === role);
  if (!agent) return null;

  const goal =
    context.goals.find((candidate) => candidate.status === "active") ??
    context.goals[0];
  const latestTask = context.tasks[0];
  const latestCheckin = context.checkins[0];
  const latestMemory = context.memories[0];
  const latestReject = context.rejects[0];
  const goalProgress = goal?.progress ?? 0;
  const energy = latestCheckin?.energy ?? config.council.minEnergy;
  const pausedCount = context.agents.filter(
    (candidate) => candidate.status === "paused",
  ).length;
  const acceptedCount = context.tasks.filter((task) =>
    ["accepted", "done"].includes(task.status),
  ).length;

  let stance: CouncilStance = "neutral";
  let claim: string;
  let risk: string;
  let recommendation: string;
  let evidence: Evidence[];

  if (role === "chief") {
    stance = goal ? "support" : "neutral";
    claim = goal
      ? `目标「${goal.title}」当前进度 ${Math.round(goalProgress)}%；近 7 天有 ${context.tasks.length} 个任务，${acceptedCount} 个已验收。`
      : "当前没有进行中的目标；如果推进，需要先明确成功标准。";
    risk = `执行资源会被新议题占用；当前有 ${pausedCount} 个 Agent 暂停。`;
    recommendation = "批准，但限定本周预算和验收标准。";
    evidence = goal
      ? [{ label: "目标进度", ref: `goal:${goal.id}`, quote: `${Math.round(goalProgress)}%` }]
      : [{ label: "Chief 状态", ref: `agent:${agent.id}`, quote: agent.title }];
  } else if (role === "researcher") {
    stance = "neutral";
    claim = latestMemory
      ? `找到 ${context.memories.length} 条相关记忆，最高显著性来自「${short(latestMemory.content)}」。`
      : "没有可引用的历史记忆；当前只能基于议题本身判断。";
    risk = "证据不足时，结论可能只是叙事。";
    recommendation = "先补 1 条可核验来源，再进入执行。";
    evidence = latestMemory
      ? [{ label: "记忆", ref: `memory:${latestMemory.id}`, quote: short(latestMemory.content) }]
      : latestTask
        ? [{ label: "最近任务", ref: `task:${latestTask.id}`, quote: latestTask.title }]
        : [{ label: "Researcher 状态", ref: `agent:${agent.id}`, quote: agent.title }];
  } else if (role === "coach") {
    const peak =
      (context.profile?.energyPattern as { peak?: string } | undefined)?.peak ??
      "未知";
    stance =
      latestCheckin && energy >= config.council.minEnergy
        ? "support"
        : "neutral";
    claim = latestCheckin
      ? `最近一次 Check-in 精力 ${energy}/5；能量高峰 ${peak}。`
      : `还没有 Check-in 数据；当前精力阈值设为 ${config.council.minEnergy}/5。`;
    risk = "低精力时段执行会拉长周期。";
    recommendation = "把执行放到高能量时段，单次不超过 25 分钟。";
    evidence = latestCheckin
      ? [{ label: "Check-in", ref: `checkin:${latestCheckin.id}`, quote: `energy ${energy}/5` }]
      : goal
        ? [{ label: "目标进度", ref: `goal:${goal.id}`, quote: `${Math.round(goalProgress)}%` }]
        : [{ label: "Coach 状态", ref: `agent:${agent.id}`, quote: agent.title }];
  } else if (role === "treasurer") {
    const percent = Math.round(context.budget.ratio * 100);
    const remaining = context.budget.limitCents - context.budget.spentCents;
    const costEfficiency = Math.max(
      0,
      Math.min(
        100,
        100 - context.budget.ratio * config.council.score.budgetPressureWeight,
      ),
    );
    stance = costEfficiency < config.council.score.base ? "oppose" : "support";
    claim = `本周预算已用 ${percent}%（${context.budget.spentCents}/${context.budget.limitCents} 分），剩余 ${remaining} 分。`;
    risk = "超支会挤压后续实验和资料预算。";
    recommendation = "设硬上限；超过上限需二次审批。";
    evidence = [
      {
        label: "预算执行",
        ref: `agent:${agent.id}`,
        quote: `${context.budget.spentCents}/${context.budget.limitCents}`,
      },
    ];
  } else {
    stance = "neutral";
    const rejectReason = latestReject?.after
      ? String(latestReject.after.reason ?? "未记录")
      : "无记录";
    claim = `过去 7 天有 ${context.rejects.length} 次审计驳回，${pausedCount} 个 Agent 处于暂停。`;
    risk = `最近一次驳回原因：${short(rejectReason)}。`;
    recommendation = "先验证证伪条件，再批准。";
    evidence = latestReject
      ? [{ label: "审计驳回", ref: `audit:${latestReject.id}`, quote: short(rejectReason) }]
      : latestTask
        ? [{ label: "最近任务", ref: `task:${latestTask.id}`, quote: latestTask.title }]
        : [{ label: "Critic 状态", ref: `agent:${agent.id}`, quote: agent.title }];
  }

  const scores = computePositionScores(
    {
      goalProgress,
      trustScore: agent.trustScore,
      budgetSpentRatio: context.budget.ratio,
      evidenceCount: evidence.filter((item) => item.ref).length,
      rejectStreak: agent.rejectStreak,
      paused: agent.status === "paused",
    },
    config.council,
  );

  if (role === "critic") {
    stance =
      scores.robustness < config.council.score.base ||
      scores.evidenceQuality < config.council.score.base
        ? "oppose"
        : "neutral";
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    agentTitle: agent.title,
    role,
    stance,
    claim,
    evidence,
    risk,
    recommendation,
    scores,
  };
}

export async function createCouncil(
  input: {
    topic: string;
    trigger: string;
  },
  userId: string,
) {
  const topic = input.topic.trim();
  const trigger = input.trigger.trim();
  if (!topic || !trigger) {
    throw new ValidationError("Topic and trigger are required.");
  }

  const config = await getPolicyConfig();
  const context = await loadCouncilContext(userId, config.budget.weeklyLimitCents);
  const id = newId("ccl");

  await db.insert(councils).values({
    id,
    userId,
    topic,
    trigger,
    status: "deliberating",
    memo: `## 议题\n${topic}\n\n## 触发\n${trigger}\n\n## 状态\n各方正在独立提交立场。`,
  });

  let positions: CouncilPositionDraft[];
  let matrix: CouncilMatrix;
  let memo: string;

  try {
    const roles = [
      "chief",
      "researcher",
      "coach",
      "treasurer",
      "critic",
    ] as const;
    const drafts = await Promise.all(
      roles.map(async (role) =>
        buildCouncilPosition({ role, context, config }),
      ),
    );
    positions = drafts.filter(
      (draft): draft is CouncilPositionDraft => draft !== null,
    );
    if (positions.length < config.council.minPositions) {
      throw new ValidationError(
        `Council needs at least ${config.council.minPositions} agents; found ${positions.length}.`,
      );
    }
    await assertEvidenceRefs(userId, positions);
    matrix = buildCouncilMatrix(
      positions.map((position) => ({
        agentId: position.agentId,
        role: position.role,
        stance: position.stance,
        scores: position.scores,
      })),
      config.council,
    );
    memo = buildCouncilMemo({ topic, trigger, positions, matrix });
  } catch (error) {
    await db
      .update(councils)
      .set({
        status: "degraded",
        memo: `## 议题\n${topic}\n\n## 触发\n${trigger}\n\n## 状态\n立场生成失败：${
          error instanceof Error ? error.message : "unknown error"
        }`,
      })
      .where(eq(councils.id, id));
    throw error;
  }

  await db.transaction(async (tx) => {
    await tx.insert(councilPositions).values(
      positions.map((position) => ({
        id: newId("cps"),
        councilId: id,
        agentId: position.agentId,
        stance: position.stance,
        claim: position.claim,
        evidence: position.evidence,
        risk: position.risk,
        recommendation: position.recommendation,
        scores: position.scores,
        isDissent: position.stance === "oppose",
        falsificationCondition:
          position.stance === "oppose"
            ? councilConditionForRole(position.role, config)
            : null,
      })),
    );
    await tx
      .update(councils)
      .set({ status: "open", matrix, memo })
      .where(eq(councils.id, id));
  });

  const [created] = await db
    .select()
    .from(councils)
    .where(eq(councils.id, id));

  await logAudit({
    userId,
    actor: "user",
    action: "council.create",
    target: id,
    before: null,
    after: {
      topic,
      trigger,
      positions: positions.length,
      matrix,
    },
  });

  return created;
}

export async function applyInsight(
  insightId: string,
  action: "accept" | "reject" | "rollback",
  userId: string,
) {
  const [insight] = await db
    .select()
    .from(insights)
    .where(eq(insights.id, insightId));
  if (!insight || insight.userId !== userId) {
    throw new NotFoundError("Insight not found");
  }

  if (action === "reject") {
    if (insight.status !== "proposed") {
      throw new ConflictError(`Cannot reject an insight in ${insight.status}.`);
    }
    const [updated] = await db
      .update(insights)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(and(eq(insights.id, insightId), eq(insights.status, "proposed")))
      .returning();
    if (!updated) throw new ConflictError("Insight state changed; retry.");
    await logAudit({
      userId: insight.userId,
      actor: "user",
      action: "insight.reject",
      target: insightId,
      before: { status: insight.status },
      after: { status: "rejected" },
    });
    return;
  }

  if (action === "rollback") {
    if (insight.status !== "applied") {
      throw new ConflictError(
        `Cannot roll back an insight in ${insight.status}.`,
      );
    }

    await db.transaction(async (tx) => {
      const [locked] = await tx
        .update(insights)
        .set({ status: "rolled_back", decidedAt: new Date() })
        .where(
          and(eq(insights.id, insightId), eq(insights.status, "applied")),
        )
        .returning();
      if (!locked) throw new ConflictError("Insight state changed; retry.");

      await reverseChange(
        tx,
        insight.proposedChange,
        insight.userId,
        insight.beforeState,
      );
    });

    await logAudit({
      userId: insight.userId,
      actor: "user",
      action: "insight.rollback",
      target: insightId,
      before: { status: insight.status },
      after: { status: "rolled_back" },
    });
    return;
  }

  if (insight.status !== "proposed") {
    throw new ConflictError(`Cannot accept an insight in ${insight.status}.`);
  }

  await db.transaction(async (tx) => {
    const state = await applyChange(tx, insight.proposedChange, insight.userId);

    const [updated] = await tx
      .update(insights)
      .set({
        status: "applied",
        beforeState: state.before,
        afterState: state.after,
        decidedAt: new Date(),
      })
      .where(and(eq(insights.id, insightId), eq(insights.status, "proposed")))
      .returning();
    if (!updated) throw new ConflictError("Insight state changed; retry.");

    const [existingMemory] = await tx
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.userId, insight.userId),
          eq(memories.sourceEventId, insight.id),
        ),
      )
      .limit(1);
    if (existingMemory) return;

    const domain =
      insight.proposedChange.type === "reschedule" ? "health" : "learning";
    const fact = factForChange(insight.proposedChange);
    await writeMemoryFact(tx, {
      userId: insight.userId,
      agentId: "ag_chief",
      type: "semantic",
      domain,
      content: insight.claim,
      confidence: insight.confidence,
      salience: 0.8,
      evidence: insight.evidence,
      sourceEventId: insight.id,
      factKey: fact?.factKey ?? null,
      value: fact?.value ?? null,
    });
  });

  await logAudit({
    userId: insight.userId,
    actor: "user",
    action: "insight.accept",
    target: insightId,
    before: { status: insight.status },
    after: { status: "applied", change: insight.proposedChange },
  });
}

export async function saveCheckin(
  input: {
    energy: number;
    mood: number;
    completed: Array<{ taskId: string; done: boolean }>;
    note: string;
  },
  userId: string,
) {
  const { user } = await getWorkspace(userId);
  const today = localDateKey(new Date(), user.timezone);
  const checkinId = newId("chk");
  await db.insert(checkins).values({
    id: checkinId,
    userId: userId,
    date: today,
    energy: input.energy,
    mood: input.mood,
    completed: input.completed,
    note: input.note,
  });

  for (const item of input.completed) {
    if (item.done) {
      const [task] = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, item.taskId));
      if (task && !["accepted", "done"].includes(task.status)) {
        await db
          .update(tasks)
          .set({ status: "done", updatedAt: new Date() })
          .where(eq(tasks.id, item.taskId));
      }
    }
  }

  if (input.note.trim()) {
    await db.insert(memories).values({
      id: newId("mem"),
      userId: userId,
      agentId: "ag_coach",
      type: "episodic",
      domain: "checkin",
      content: input.note.trim(),
      confidence: 0.9,
      salience: 0.55,
      evidence: [
        { label: "今日 check-in", ref: `checkin:${checkinId}` },
      ],
      sourceEventId: checkinId,
      lastConfirmedAt: new Date(),
    });
  }

  await logAudit({
    userId: userId,
    actor: "user",
    action: "checkin.save",
    target: today,
    before: null,
    after: { energy: input.energy, mood: input.mood },
  });
}

export async function runApprenticeExam(userId: string) {
  const [apprentice] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, "ag_apprentice"));
  if (!apprentice || apprentice.userId !== userId) {
    throw new NotFoundError("Apprentice not found");
  }

  if (!["shadowing", "drafting", "examining"].includes(apprentice.lifecycleStage)) {
    throw new ConflictError(
      `Apprentice is already ${apprentice.lifecycleStage}.`,
    );
  }

  const [skill] = await db
    .select()
    .from(skills)
    .where(eq(skills.agentId, "ag_apprentice"))
    .orderBy(desc(skills.createdAt))
    .limit(1);

  const examChecklist = skill?.evalSet ?? [];
  if (examChecklist.length === 0) {
    throw new ValidationError("Skill has no eval set; cannot run the exam.");
  }
  const examDraft = draftFor(
    "apprentice",
    skill?.name ?? "检索评估练习设计",
    0,
  );
  const examResults = evaluateAcceptance(examDraft.content, examChecklist);
  const required = examChecklist.length;
  const passed = examResults.filter((result) => result.passed).length;

  const examTaskId = `exam_${apprentice.id}`;
  const [existingExamTask] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, examTaskId))
    .limit(1);

  if (!existingExamTask) {
    await db.insert(tasks).values({
      id: examTaskId,
      userId: apprentice.userId,
      title: "学徒结业考试",
      description: "5 个留出任务，覆盖检索评估练习设计。",
      assigneeId: apprentice.id,
      auditorId: "ag_auditor",
      status: "done",
      priority: 2,
      acceptanceCriteria: "按技能 eval set 逐项验收；Auditor 监考。",
      acceptanceChecklist: examChecklist,
      acceptanceReport: examResults,
      estimateMin: 30,
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 0,
      createdBy: "system",
    });
  }

  if (apprentice.lifecycleStage === "shadowing") {
    assertTransition("apprentice", "shadowing", "drafting");
  }
  if (apprentice.lifecycleStage !== "examining") {
    assertTransition("apprentice", "drafting", "examining");
  }

  const runId = newId("run");
  await db.insert(runs).values({
    id: runId,
    taskId: examTaskId,
    agentId: "ag_apprentice",
    status: "succeeded",
    mode: "demo",
    startedAt: new Date(),
    endedAt: new Date(),
    costCents: 0.6,
    tokensIn: 400,
    tokensOut: 220,
    replayKey: "apprentice_exam_v1",
  });
  await db.insert(steps).values([
    {
      id: newId("stp"),
      runId,
      idx: 1,
      type: "tool",
      tool: "read_runs",
      input: { mentor: apprentice.mentorId ?? "ag_coach", runs: 5 },
      output: { loaded: 5 },
      tokensIn: 200,
      tokensOut: 0,
      latencyMs: 120,
    },
    {
      id: newId("stp"),
      runId,
      idx: 2,
      type: "draft",
      input: { skill: skill?.name ?? "检索评估练习设计" },
      output: { rubric: true },
      tokensIn: 120,
      tokensOut: 160,
      latencyMs: 500,
    },
    {
      id: newId("stp"),
      runId,
      idx: 3,
      type: "audit",
      input: { heldOutTasks: required },
      output: { passed, required, results: examResults },
      tokensIn: 80,
      tokensOut: 60,
      latencyMs: 300,
    },
  ]);

  if (passed < required) {
    if (skill) {
      await db
        .update(skills)
        .set({
          eval: { status: "failed", required, passed, results: examResults },
        })
        .where(eq(skills.id, skill.id));
    }
    await logAudit({
      userId: apprentice.userId,
      actor: "agent:ag_auditor",
      action: "apprentice.exam_failed",
      target: apprentice.id,
      before: { stage: apprentice.lifecycleStage },
      after: { stage: apprentice.lifecycleStage, passed, required },
    });
    return { runId, passed, required, promoted: false };
  }

  const [promoted] = await db
    .update(agents)
    .set({
      lifecycleStage: "active",
      status: "active",
      trustScore: clamp(apprentice.trustScore + 10),
      successCount: apprentice.successCount + 1,
      autonomyLevel: 2,
      rejectStreak: 0,
    })
    .where(
      and(
        eq(agents.id, apprentice.id),
        inArray(agents.lifecycleStage, [
          "shadowing",
          "drafting",
          "examining",
        ]),
      ),
    )
    .returning();
  if (!promoted) throw new ConflictError("Apprentice was already promoted.");

  if (skill) {
    await db
      .update(skills)
      .set({
        status: "active",
        label: "production",
        successCount: 1,
        eval: { status: "passed", required, passed, results: examResults },
      })
      .where(
        and(eq(skills.id, skill.id), inArray(skills.status, ["draft", "exam"])),
      );
  }

  await logAudit({
    userId: apprentice.userId,
    actor: "agent:ag_auditor",
    action: "apprentice.promote",
    target: apprentice.id,
    before: { stage: apprentice.lifecycleStage },
    after: {
      stage: "active",
      exam: `${passed}/${required}`,
      skill: "active",
    },
  });

  return { runId, passed, required };
}

export async function regenerateBrief(userId: string) {
  const data = await getTodayData(userId);
  const lines = [
    `# ${new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric" })} 早报`,
    "",
    `目标：${data.goals.map((g) => `${g.title}（${Math.round(g.progress)}%）`).join(" · ")}`,
    "",
    "## 今天的关键判断",
    data.tasks.length > 0
      ? `- 今天有 ${data.tasks.length} 个待推进任务，优先处理已提交待验收的。`
      : "- 今天没有待推进任务，适合复盘或补弱项。",
    `- 需要你决定：${data.approvals.length} 个审批${data.council ? " + 1 个内阁会议" : ""}。`,
    "",
    "## 建议顺序",
    ...data.tasks.slice(0, 3).map((t, i) => `${i + 1}. ${t.title}（${t.estimateMin} 分钟）`),
  ];
  const content = lines.join("\n");
  await db.insert(reviews).values({
    id: newId("rev"),
    userId: userId,
    period: localDateKey(new Date(), data.user.timezone),
    type: "daily",
    narrative: content,
    metrics: { tasks: data.tasks.length, decisions: data.approvals.length },
    decisions: [],
  });
  return content;
}

function localHourIn(date: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    timeZone,
  }).format(date);
  return Number(hour) % 24;
}

function localTimeIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(date);
}

function peakStart(profile: typeof profiles.$inferSelect | undefined): string | null {
  const peak = (profile?.energyPattern as { peak?: string } | undefined)?.peak;
  const start = peak?.split("-")[0]?.trim();
  return start && /^\d{2}:\d{2}$/.test(start) ? start : null;
}

function dissentConditionMet(
  value: number,
  condition: FalsificationCondition,
): boolean {
  if (condition.operator === ">=") return value >= condition.threshold;
  if (condition.operator === ">") return value > condition.threshold;
  return value === condition.threshold;
}

async function measureDissent(
  userId: string,
  dissent: typeof dissents.$inferSelect,
): Promise<number> {
  const start = dissent.createdAt;
  const end = new Date(
    start.getTime() + dissent.condition.windowDays * 24 * 60 * 60 * 1000,
  );
  const metric = dissent.condition.metric;

  if (metric === "audit_reject_count") {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, userId),
          eq(auditEvents.action, "audit.reject"),
          gte(auditEvents.createdAt, start),
          lte(auditEvents.createdAt, end),
        ),
      );
    return Number(row?.count ?? 0);
  }

  if (metric === "budget_spend_cents") {
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${runs.costCents}), 0)` })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(
        and(
          eq(tasks.userId, userId),
          gte(runs.createdAt, start),
          lte(runs.createdAt, end),
        ),
      );
    return Number(row?.total ?? 0);
  }

  if (metric === "task_failure_count") {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.status, "failed"),
          gte(tasks.createdAt, start),
          lte(tasks.createdAt, end),
        ),
      );
    return Number(row?.count ?? 0);
  }

  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.status, "paused")));
  return Number(row?.count ?? 0);
}

/**
 * Evaluate pending formal dissents after their observation window closes.
 * Only the Auditor-like system path mutates trust; the Chief cannot judge their
 * own dissent, and a dissent is evaluated at most once.
 */
export async function evaluateDissents(userId: string): Promise<{
  vindicated: number;
  invalidated: number;
}> {
  const config = await getPolicyConfig();
  const pending = await db
    .select()
    .from(dissents)
    .where(and(eq(dissents.userId, userId), eq(dissents.status, "pending")));

  let vindicated = 0;
  let invalidated = 0;

  for (const dissent of pending) {
    const deadline = new Date(
      dissent.createdAt.getTime() +
        dissent.condition.windowDays * 24 * 60 * 60 * 1000,
    );
    if (deadline > new Date()) continue;

    const value = await measureDissent(userId, dissent);
    const met = dissentConditionMet(value, dissent.condition);
    const evidence: Evidence[] = [
      ...dissent.evidence,
      {
        label: "复盘测量",
        ref: `dissent:${dissent.id}`,
        quote: `${dissent.condition.metric} = ${value}`,
      },
    ];

    if (!met) {
      const [updated] = await db
        .update(dissents)
        .set({
          status: "invalidated",
          evidence,
          evaluatedAt: new Date(),
        })
        .where(
          and(eq(dissents.id, dissent.id), eq(dissents.status, "pending")),
        )
        .returning();
      if (!updated) continue;
      invalidated += 1;
      await logAudit({
        userId,
        actor: "system:auditor",
        action: "dissent.invalidated",
        target: dissent.id,
        before: { status: "pending" },
        after: {
          status: "invalidated",
          metric: dissent.condition.metric,
          value,
          threshold: dissent.condition.threshold,
        },
      });
      continue;
    }

    let chief: typeof agents.$inferSelect | undefined;
    let chiefBefore: number | null = null;
    let chiefAfter: number | null = null;
    let updatedDissent: typeof dissents.$inferSelect | undefined;

    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(dissents)
        .set({
          status: "vindicated",
          evidence,
          evaluatedAt: new Date(),
        })
        .where(
          and(eq(dissents.id, dissent.id), eq(dissents.status, "pending")),
        )
        .returning();
      if (!updated) return;
      updatedDissent = updated;

      const [agent] = await tx
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.id, dissent.agentId),
            eq(agents.userId, userId),
          ),
        )
        .limit(1);
      if (agent) {
        await tx
          .update(agents)
          .set({
            trustScore: clamp(agent.trustScore + config.dissent.trustBonus),
          })
          .where(eq(agents.id, agent.id));
      }

      [chief] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.userId, userId), eq(agents.role, "chief")))
        .limit(1);
      if (chief) {
        chiefBefore = chief.trustScore;
        chiefAfter = clamp(chief.trustScore - config.dissent.chiefPenalty);
        await tx
          .update(agents)
          .set({ trustScore: chiefAfter })
          .where(eq(agents.id, chief.id));
      }

      const [council] = await tx
        .select()
        .from(councils)
        .where(eq(councils.id, dissent.councilId))
        .limit(1);
      const topic = council?.topic ?? dissent.councilId;
      await writeMemoryFact(tx, {
        userId,
        agentId: dissent.agentId,
        type: "procedural",
        domain: "council",
        content: `判例（${topic}）：${dissent.warning} 已被现实印证。测量值 ${value}，阈值 ${dissent.condition.operator} ${dissent.condition.threshold}。`,
        confidence: 0.9,
        salience: config.dissent.precedentSalience,
        evidence,
        sourceEventId: dissent.id,
        factKey: `precedent:${factSlug(topic)}`,
        value: `vindicated:${value}`,
      });
    });

    if (!updatedDissent) continue;
    vindicated += 1;

    await logAudit({
      userId,
      actor: "system:auditor",
      action: "dissent.vindicated",
      target: dissent.id,
      before: { status: "pending" },
      after: {
        status: "vindicated",
        metric: dissent.condition.metric,
        value,
        threshold: dissent.condition.threshold,
        trustBonus: config.dissent.trustBonus,
        chiefPenalty: config.dissent.chiefPenalty,
      },
    });

    if (chief && chiefBefore !== null) {
      await logAudit({
        userId,
        actor: "system:auditor",
        action: "chief.deviation",
        target: chief.id,
        before: { trustScore: chiefBefore },
        after: {
          trustScore: chiefAfter,
          dissentId: dissent.id,
          councilId: dissent.councilId,
        },
      });
    }
  }

  return { vindicated, invalidated };
}

type ReflectionCandidate = {
  claim: string;
  rationale: string;
  confidence: number;
  evidence: Evidence[];
  proposedChange: ProposedChange;
};

export async function runReflection(
  userId: string,
): Promise<typeof insights.$inferSelect | null> {
  const { user, profile } = await getWorkspace(userId);
  const config = await getPolicyConfig();
  await evaluateDissents(userId);
  const now = new Date();
  const since = new Date(
    now.getTime() - config.reflection.windowDays * 24 * 60 * 60 * 1000,
  );

  const [latestCheckin] = await db
    .select()
    .from(checkins)
    .where(
      and(eq(checkins.userId, userId), gte(checkins.createdAt, since)),
    )
    .orderBy(desc(checkins.createdAt))
    .limit(1);
  const allTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.userId, userId))
    .orderBy(desc(tasks.createdAt))
    .limit(200);
  const recentTasks = allTasks.filter(
    (task) => task.createdAt >= since || (task.dueAt && task.dueAt >= since),
  );
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
    .orderBy(desc(auditEvents.createdAt));
  const allAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, userId));

  const candidates: ReflectionCandidate[] = [];

  if (recentRejects.length >= config.reflection.minRejectEvents) {
    const reasons = new Map<string, number>();
    for (const event of recentRejects) {
      const reason = String(event.after?.reason ?? "验收标准未满足").trim();
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    const [topReason, topCount] = [...reasons.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0] ?? ["验收标准未满足", recentRejects.length];
    const first = recentRejects[0];
    const rejectedTask = recentTasks.find((task) => task.id === first.target);
    const evidence: Evidence[] = [
      {
        label: `审计驳回 ×${recentRejects.length}`,
        ref: `audit:${first.id}`,
        quote: short(topReason),
      },
    ];
    if (rejectedTask) {
      evidence.push({
        label: "被驳回任务",
        ref: `task:${rejectedTask.id}`,
        quote: rejectedTask.title,
      });
    }
    candidates.push({
      claim: `最近 ${config.reflection.windowDays} 天有 ${recentRejects.length} 次审计驳回，主要原因是「${short(topReason)}」；建议把验收清单设为任务模板的必填项。`,
      rationale: `按 audit.reject 统计，${config.reflection.windowDays} 天内共 ${recentRejects.length} 次驳回，「${topReason}」出现 ${topCount} 次。驳回集中在验收标准，而不是执行能力。`,
      confidence: config.reflection.confidence,
      evidence,
      proposedChange: {
        type: "add_rule",
        rule: "任务模板必须包含验收清单（rubric），提交前逐项自检。",
      },
    });
  }

  const eveningTasks = recentTasks.filter(
    (task) =>
      task.dueAt &&
      localHourIn(task.dueAt, user.timezone) >= config.reflection.eveningHour,
  );
  const eveningDone = eveningTasks.filter((task) =>
    ["accepted", "done"].includes(task.status),
  ).length;
  if (
    eveningTasks.length >= config.reflection.minTaskSample &&
    eveningDone / eveningTasks.length <
      config.reflection.eveningCompletionThreshold
  ) {
    const open = eveningTasks.filter(
      (task) => !["accepted", "done", "cancelled"].includes(task.status),
    );
    const target =
      open.find((task) => task.estimateMin >= 25) ?? open[0] ?? null;
    const peak = peakStart(profile);
    if (target?.dueAt && peak) {
      const from = localTimeIn(target.dueAt, user.timezone);
      const evidence: Evidence[] = [
        {
          label: "晚间任务",
          ref: `task:${target.id}`,
          quote: `${from} · ${target.title}`,
        },
      ];
      if (latestCheckin) {
        evidence.push({
          label: "最近 Check-in",
          ref: `checkin:${latestCheckin.id}`,
          quote: `energy ${latestCheckin.energy}/5${latestCheckin.note ? ` · ${latestCheckin.note}` : ""}`,
        });
      }
      candidates.push({
        claim: `晚间（${config.reflection.eveningHour}:00 后）安排了 ${eveningTasks.length} 个任务，只完成 ${eveningDone} 个；建议把「${target.title}」移到 ${peak}。`,
        rationale: `统计口径：过去 ${config.reflection.windowDays} 天内、截止时间在当地 ${config.reflection.eveningHour}:00 之后的任务，完成率 ${Math.round(
          (eveningDone / eveningTasks.length) * 100,
        )}%，低于阈值 ${Math.round(
          config.reflection.eveningCompletionThreshold * 100,
        )}%。高能量时段来自你的 profile：${peak}。`,
        confidence: config.reflection.confidence,
        evidence,
        proposedChange: {
          type: "reschedule",
          taskId: target.id,
          from,
          to: peak,
        },
      });
    }
  }

  if (
    latestCheckin &&
    latestCheckin.energy <= config.reflection.lowEnergyThreshold
  ) {
    candidates.push({
      claim: `最近一次 Check-in 精力只有 ${latestCheckin.energy}/5；低精力日建议只排 25 分钟以内的任务。`,
      rationale: `这不是意志力问题，是负荷与精力不匹配：最近一次 Check-in 记录为 ${latestCheckin.energy}/5，备注「${latestCheckin.note || "无"}」。`,
      confidence: config.reflection.confidence,
      evidence: [
        {
          label: "最近 Check-in",
          ref: `checkin:${latestCheckin.id}`,
          quote: `energy ${latestCheckin.energy}/5`,
        },
      ],
      proposedChange: {
        type: "add_rule",
        rule: "低精力日只安排 25 分钟以内的任务，并把高认知任务移到高能量时段。",
      },
    });
  }

  const spentCents = allAgents.reduce(
    (sum, agent) => sum + Number(agent.spentCents ?? 0),
    0,
  );
  const budgetRatio =
    config.budget.weeklyLimitCents > 0
      ? spentCents / config.budget.weeklyLimitCents
      : 0;
  if (budgetRatio >= config.reflection.budgetPressureRatio) {
    const treasurer =
      allAgents.find((agent) => agent.role === "treasurer") ?? allAgents[0];
    if (treasurer) {
      candidates.push({
        claim: `本周预算已用 ${Math.round(budgetRatio * 100)}%（${spentCents}/${config.budget.weeklyLimitCents} 分），建议把非必要支出改成二次审批。`,
        rationale: `按 agents.spent_cents 汇总，本周已支出 ${spentCents} 分，预算上限 ${config.budget.weeklyLimitCents} 分；触发阈值 ${Math.round(
          config.reflection.budgetPressureRatio * 100,
        )}%。`,
        confidence: config.reflection.confidence,
        evidence: [
          {
            label: "预算执行",
            ref: `agent:${treasurer.id}`,
            quote: `${spentCents}/${config.budget.weeklyLimitCents}`,
          },
        ],
        proposedChange: {
          type: "add_rule",
          rule: "预算使用超过阈值时，非必要支出必须二次审批。",
        },
      });
    }
  }

  const paused = allAgents.filter((agent) => agent.status === "paused");
  if (paused.length > 0) {
    candidates.push({
      claim: `有 ${paused.length} 个 Agent 处于暂停状态；恢复前应先完成一次补课任务。`,
      rationale: `暂停通常是连续审计驳回或策略拦截的结果。当前暂停：${paused
        .map((agent) => `${agent.name}（${agent.role}）`)
        .join("、")}。`,
      confidence: config.reflection.confidence,
      evidence: [
        {
          label: "暂停 Agent",
          ref: `agent:${paused[0].id}`,
          quote: `${paused[0].name} · ${paused[0].role}`,
        },
      ],
      proposedChange: {
        type: "add_rule",
        rule: "暂停的 Agent 恢复前必须完成一次补课任务并重新验收。",
      },
    });
  }

  for (const candidate of candidates) {
    const [existing] = await db
      .select()
      .from(insights)
      .where(
        and(eq(insights.userId, userId), eq(insights.claim, candidate.claim)),
      )
      .limit(1);
    if (existing) continue;

    const [created] = await db
      .insert(insights)
      .values({
        id: newId("ins"),
        userId,
        claim: candidate.claim,
        rationale: candidate.rationale,
        confidence: candidate.confidence,
        evidence: candidate.evidence,
        proposedChange: candidate.proposedChange,
        status: "proposed",
      })
      .returning();

    await logAudit({
      userId,
      actor: "agent:ag_coach",
      action: "insight.propose",
      target: created.id,
      before: null,
      after: {
        claim: created.claim,
        confidence: created.confidence,
        evidenceRefs: candidate.evidence.map((item) => item.ref).filter(Boolean),
      },
    });
    return created;
  }

  return null;
}

export function currentWeek() {
  return weekLabel(new Date());
}
