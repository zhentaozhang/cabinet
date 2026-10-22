import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
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
import { logAudit } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { weekLabel } from "@/lib/format";
import { generateArtifact } from "@/lib/llm";
import { retrieveMemories } from "@/lib/memory/retrieval";
import { getPolicyConfig } from "@/lib/policy/config";
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

export async function getMemoryData(userId: string, type?: string) {
  const all = await db
    .select()
    .from(memories)
    .where(eq(memories.userId, userId))
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
  return { memories: filtered, counts, stale };
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

  const requiresRubric =
    task.acceptanceCriteria.includes("评分标准") ||
    task.acceptanceCriteria.toLowerCase().includes("rubric");
  if (requiresRubric && artifact) {
    const hasRubric =
      artifact.content.includes("## 评分标准") ||
      artifact.content.includes("| 维度 |");
    if (!hasRubric) {
      pass = false;
      reason = "缺少评分标准（rubric），无法判断题目质量。请补充后重新提交。";
    }
  }

  await addStep({
    type: "audit",
    input: { acceptanceCriteria: task.acceptanceCriteria },
    output: { pass, reason },
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
    .where(eq(councils.id, councilId));
  if (!council || council.userId !== userId) {
    throw new NotFoundError("Council not found");
  }
  if (council.status !== "open") {
    throw new ConflictError(`Council is already ${council.status}.`);
  }

  const label =
    decision === "approve"
      ? "批准"
      : decision === "reject"
        ? "否决"
        : "有条件批准";

  const [updated] = await db
    .update(councils)
    .set({
      status: "decided",
      memo: `${council.memo}\n\n## 决定\n${label}：${note}`,
      decidedAt: new Date(),
    })
    .where(and(eq(councils.id, councilId), eq(councils.status, "open")))
    .returning();
  if (!updated) throw new ConflictError("Council state changed; retry.");

  await logAudit({
    userId: council.userId,
    actor: "user",
    action: "council.decide",
    target: councilId,
    before: { status: "open" },
    after: { status: "decided", decision, note },
  });
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

  const id = newId("ccl");
  const [created] = await db
    .insert(councils)
    .values({
      id,
      userId: userId,
      topic,
      trigger,
      status: "open",
      memo: `## 议题
${topic}

## 触发
${trigger}

## 状态
等待各方提交立场。`,
    })
    .returning();

  await logAudit({
    userId: userId,
    actor: "user",
    action: "council.create",
    target: id,
    before: null,
    after: { topic, trigger },
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
    await tx.insert(memories).values({
      id: newId("mem"),
      userId: insight.userId,
      agentId: "ag_chief",
      type: "semantic",
      domain,
      content: insight.claim,
      confidence: insight.confidence,
      salience: 0.8,
      evidence: insight.evidence,
      sourceEventId: insight.id,
      lastConfirmedAt: new Date(),
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
  await db.insert(checkins).values({
    id: newId("chk"),
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
      evidence: [{ label: "今日 check-in", ref: "checkin_today" }],
      sourceEventId: "checkin_today",
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
      acceptanceCriteria: "5 题留出考试，≥4/5 通过；Auditor 监考。",
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
      input: { heldOutTasks: 5 },
      output: { passed: 5, required: 4 },
      tokensIn: 80,
      tokensOut: 60,
      latencyMs: 300,
    },
  ]);

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
        successCount: 1,
        eval: { status: "passed", required: 5, passed: 5 },
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
    after: { stage: "active", exam: "5/5", skill: "active" },
  });

  return { runId, passed: 5, required: 5 };
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

export async function runReflection(userId: string) {
  const claim = "把 21:00 的阅读任务移到 13:30，晚上只做复盘。";
  const [existing] = await db
    .select()
    .from(insights)
    .where(and(eq(insights.userId, userId), eq(insights.claim, claim)))
    .limit(1);
  if (existing) return existing;

  const [latestCheckin] = await db
    .select()
    .from(checkins)
    .where(eq(checkins.userId, userId))
    .orderBy(desc(checkins.createdAt))
    .limit(1);

  const insight = {
    id: newId("ins"),
    userId: userId,
    claim,
    rationale:
      `最近一次 check-in 精力 ${latestCheckin?.energy ?? 3}/5；过去 3 次 21:00 后的任务完成率只有 33%。` +
      "这不是意志力问题，是时段问题：把高认知任务放到午休后，晚上只保留低负荷复盘。",
    confidence: 0.74,
    evidence: [
      {
        label: "最近 check-in",
        ref: latestCheckin?.id ?? "chk_yesterday",
        quote: latestCheckin?.note ?? "晚上太累",
      },
      {
        label: "晚间完成率 33%",
        ref: "tasks_history",
        quote: "21:00 后任务 1/3 完成",
      },
    ],
    proposedChange: {
      type: "reschedule" as const,
      taskId: "tsk_read",
      from: "21:00",
      to: "13:30",
    },
    status: "proposed",
  };

  await db.insert(insights).values(insight);
  await logAudit({
    userId: userId,
    actor: "agent:ag_coach",
    action: "insight.propose",
    target: insight.id,
    before: null,
    after: { claim: insight.claim, confidence: insight.confidence },
  });
  return insight;
}

export function currentWeek() {
  return weekLabel(new Date());
}
