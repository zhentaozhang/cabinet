import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  auditEvents,
  checkins,
  insights,
  profiles,
  tasks,
} from "@/lib/db/schema";
import type { Evidence, ProposedChange } from "@/lib/db/schema";
import { logAudit } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { getPolicyConfig } from "@/lib/policy/config";
import { getWorkspace } from "../queries/workspace";
import { evaluateDissents } from "./council/dissent";
import { short } from "../shared/text";

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
