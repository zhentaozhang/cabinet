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
  topic: string;
}): CouncilPositionDraft | null {
  const { role, context, config, topic } = input;
  const agent = context.agents.find((candidate) => candidate.role === role);
  if (!agent) return null;
  const topicLabel = short(topic.trim(), 60);

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
      ? `议题「${topicLabel}」可以挂到目标「${goal.title}」上：当前进度 ${Math.round(goalProgress)}%；近 7 天有 ${context.tasks.length} 个任务，${acceptedCount} 个已验收。`
      : `议题「${topicLabel}」没有可挂靠的进行中目标；推进前需要先定义成功标准。`;
    risk = `批准「${topicLabel}」会占用本周执行资源；当前有 ${pausedCount} 个 Agent 暂停。`;
    recommendation = `批准「${topicLabel}」，但限定本周预算和验收标准。`;
    evidence = goal
      ? [{ label: "目标进度", ref: `goal:${goal.id}`, quote: `${Math.round(goalProgress)}%` }]
      : [{ label: "Chief 状态", ref: `agent:${agent.id}`, quote: agent.title }];
  } else if (role === "researcher") {
    stance = "neutral";
    claim = latestMemory
      ? `围绕「${topicLabel}」找到 ${context.memories.length} 条相关记忆，最高显著性来自「${short(latestMemory.content)}」。`
      : `围绕「${topicLabel}」没有可引用的历史记忆；当前只能基于议题本身判断。`;
    risk = `「${topicLabel}」的证据不足时，结论可能只是叙事。`;
    recommendation = `先为「${topicLabel}」补 1 条可核验来源，再进入执行。`;
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
      ? `围绕「${topicLabel}」，最近一次 Check-in 精力 ${energy}/5；能量高峰 ${peak}。`
      : `围绕「${topicLabel}」还没有 Check-in 数据；当前精力阈值设为 ${config.council.minEnergy}/5。`;
    risk = `在低精力时段推进「${topicLabel}」会拉长周期。`;
    recommendation = `把「${topicLabel}」的执行放到高能量时段，单次不超过 25 分钟。`;
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
    claim = `议题「${topicLabel}」相关支出：本周预算已用 ${percent}%（${context.budget.spentCents}/${context.budget.limitCents} 分），剩余 ${remaining} 分。`;
    risk = `「${topicLabel}」若超支会挤压后续实验和资料预算。`;
    recommendation = `为「${topicLabel}」设硬上限；超过上限需二次审批。`;
    evidence = [
      {
        label: "预算执行",
        ref: `agent:${agent.id}`,
        quote: `${context.budget.spentCents}/${context.budget.limitCents}`,
      },
    ];
  } else {
    // The Critic's job is to argue the opposite; a supportive Critic would
    // make the session theatrics rather than a real challenge.
    stance = "oppose";
    const rejectReason = latestReject?.after
      ? String(latestReject.after.reason ?? "未记录")
      : "无记录";
    claim = `我反对推进「${topicLabel}」：过去 7 天有 ${context.rejects.length} 次审计驳回，${pausedCount} 个 Agent 处于暂停。`;
    risk = latestReject
      ? `「${topicLabel}」最近一次驳回原因：${short(rejectReason)}。`
      : `「${topicLabel}」缺少可证伪的失败路径记录，风险还没有被验证。`;
    recommendation = `先为「${topicLabel}」写出证伪条件和止损线，再批准。`;
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
