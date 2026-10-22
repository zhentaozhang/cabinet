import type { Evidence } from "@/lib/db/schema";
import type { CouncilPositionDraft, CouncilStance } from "@/lib/domain/council";
import { computePositionScores } from "@/lib/domain/council";
import { getPolicyConfig } from "@/lib/policy/config";
import { short } from "../../shared/text";
import type { CouncilContext } from "./context";

export function buildCouncilPosition(input: {
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
