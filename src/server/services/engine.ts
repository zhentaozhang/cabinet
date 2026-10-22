import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  auditEvents,
  checkins,
  insights,
  profiles,
  runs,
  skills,
  steps,
  tasks,
} from "@/lib/db/schema";
import type { Evidence, ProposedChange } from "@/lib/db/schema";
import { evaluateAcceptance } from "@/lib/domain/acceptance";
import { logAudit } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { clamp } from "./shared/numbers";
import { draftFor } from "./shared/draft";
import { short } from "./shared/text";
import { currentWeek } from "./shared/time";
import { getWorkspace } from "./queries/workspace";
import { evaluateDissents } from "./commands/council/dissent";
import { getPolicyConfig } from "@/lib/policy/config";
import { assertTransition } from "@/lib/domain/state";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/lib/domain/errors";

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
export * from "./commands/council/context";
export * from "./commands/council/positions";
export * from "./commands/council/create";
export * from "./commands/council/decide";
export * from "./commands/council/dissent";

export { currentWeek };

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