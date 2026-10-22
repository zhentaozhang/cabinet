import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lte,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  auditEvents,
  checkins,
  councilPositions,
  councils,
  dissents,
  goals,
  insights,
  memories,
  profiles,
  runs,
  skills,
  steps,
  tasks,
} from "@/lib/db/schema";
import type {
  CouncilMatrix,
  CouncilResolution,
  Evidence,
  FalsificationCondition,
  ProposedChange,
} from "@/lib/db/schema";
import {
  evaluateAcceptance,
} from "@/lib/domain/acceptance";
import { logAudit } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { clamp } from "./shared/numbers";
import { draftFor } from "./shared/draft";
import { short } from "./shared/text";
import { currentWeek } from "./shared/time";
import { getWorkspace } from "./queries/workspace";
import { factSlug, writeMemoryFact } from "./commands/memory/facts";

export * from "./queries/workspace";
export * from "./queries/metrics";
export * from "./queries/today";
export * from "./queries/cabinet";
export * from "./queries/agent";
export * from "./queries/task";
export * from "./queries/review";
export * from "./queries/memory";
export * from "./queries/council";
export * from "./commands/agents";
export * from "./commands/goals";
export * from "./commands/checkins";
export * from "./commands/brief";
export * from "./commands/memory/facts";
export * from "./commands/memory/insights";
export * from "./commands/tasks/execution";
export * from "./commands/tasks/approvals";
export * from "./commands/tasks/run";
export * from "./commands/tasks/audit";
export * from "./commands/tasks/create";
import { getPolicyConfig } from "@/lib/policy/config";
import {
  buildCouncilMatrix,
  buildCouncilMemo,
  computePositionScores,
  type CouncilPositionDraft,
  type CouncilStance,
} from "@/lib/domain/council";
import { assertTransition } from "@/lib/domain/state";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/lib/domain/errors";

export { currentWeek };

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
          dissent.taskId
            ? eq(auditEvents.target, dissent.taskId)
            : undefined,
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
          dissent.taskId ? eq(runs.taskId, dissent.taskId) : undefined,
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
          dissent.taskId ? eq(tasks.id, dissent.taskId) : undefined,
          gte(tasks.updatedAt, start),
          lte(tasks.updatedAt, end),
        ),
      );
    return Number(row?.count ?? 0);
  }

  // `agent_paused` must be measured from events inside the observation window.
  // Reading agents.status alone would make any historical pause permanently
  // vindicate every future dissent.
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.userId, userId),
        inArray(auditEvents.action, ["agent.paused", "agent.update"]),
        sql`${auditEvents.after}->>'status' = 'paused'`,
        gte(auditEvents.createdAt, start),
        lte(auditEvents.createdAt, end),
      ),
    );
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
      assertTransition("dissent", dissent.status, "invalidated");
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

    assertTransition("dissent", dissent.status, "vindicated");
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