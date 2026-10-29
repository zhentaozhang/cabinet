import type { Evidence } from "@/lib/db/schema";
import type { CouncilPositionDraft, CouncilStance } from "@/lib/domain/council";
import { computePositionScores, goalProgressSignal } from "@/lib/domain/council";
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

  // 议题挂在「最近在推的那个目标」上。不能只取第一个活跃目标：一批种下的目标
  // created_at 相同（同一条 insert），谁被读到由物理行序决定，Chief 就会把任何
  // 议题都挂到同一个目标上——进度也跟着错，而它还进 computePositionScores。
  const activeGoals = context.goals.filter(
    (candidate) => candidate.status === "active",
  );
  const goal =
    context.tasks
      .map((task) =>
        activeGoals.find((candidate) => candidate.id === task.goalId),
      )
      .find((candidate) => Boolean(candidate)) ??
    activeGoals[0] ??
    context.goals[0];
  const latestTask = context.tasks[0];
  const latestCheckin = context.checkins[0];
  const latestMemory = context.memories[0];
  const latestReject = context.rejects[0];
  // 学习域才有在算的进度；其余域给 null，claim 与证据都不印数字。
  // 之前这里是 `goal?.progress ?? 0`，于是健康目标那条写死的 60 会以
  // 「当前进度 60%」进 Chief 的 claim 和审计里复用的 evidence quote。
  const goalProgress = goal
    ? goalProgressSignal(goal.domain, goal.progress)
    : null;
  const energy = latestCheckin?.energy ?? config.council.minEnergy;
  const pausedCount = context.agents.filter(
    (candidate) => candidate.status === "paused",
  ).length;
  const { last7d: weeklyTaskCount, accepted: acceptedCount } = context.taskStats;

  let stance: CouncilStance = "neutral";
  let claim: string;
  let risk: string;
  let recommendation: string;
  let evidence: Evidence[];

  if (role === "chief") {
    stance = goal ? "support" : "neutral";
    claim = goal
      ? goalProgress == null
        ? `议题「${topicLabel}」可以挂到目标「${goal.title}」上：这个目标不是学习类，进度没有在算（Cabinet 只按学习任务的验收与打卡推算），这里不给数字；近 7 天有 ${weeklyTaskCount} 个任务，${acceptedCount} 个已验收。`
        : `议题「${topicLabel}」可以挂到目标「${goal.title}」上：当前进度 ${Math.round(goalProgress)}%；近 7 天有 ${weeklyTaskCount} 个任务，${acceptedCount} 个已验收。`
      : `议题「${topicLabel}」没有可挂靠的进行中目标；推进前需要先定义成功标准。`;
    risk = `批准「${topicLabel}」会占用本周执行资源；当前有 ${pausedCount} 个 Agent 暂停。`;
    recommendation = `批准「${topicLabel}」，但限定本周预算和验收标准。`;
    evidence = goal
      ? [
          goalProgress == null
            ? // 没有在算的进度不能当证据引用：quote 写标题，标签也改成「归属」，
              // 免得读者以为这里只是没显示出来。
              { label: "目标归属", ref: `goal:${goal.id}`, quote: goal.title }
            : { label: "目标进度", ref: `goal:${goal.id}`, quote: `${Math.round(goalProgress)}%` },
        ]
      : [{ label: "Chief 状态", ref: `agent:${agent.id}`, quote: agent.title }];
  } else if (role === "researcher") {
    stance = "neutral";
    claim = latestMemory
      ? `围绕「${topicLabel}」按议题词检索到 ${context.memories.length} 条相关记忆，打分最高的是「${short(latestMemory.content)}」。`
      : `围绕「${topicLabel}」没有检索到相关的历史记忆；当前只能基于议题本身判断。`;
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
        ? [
            goalProgress == null
              ? { label: "目标归属", ref: `goal:${goal.id}`, quote: goal.title }
              : { label: "目标进度", ref: `goal:${goal.id}`, quote: `${Math.round(goalProgress)}%` },
          ]
        : [{ label: "Coach 状态", ref: `agent:${agent.id}`, quote: agent.title }];
  } else if (role === "treasurer") {
    // 额度是分桶的：全工作区能花的是各 Agent 额度之和，不是某个 Agent 的上限。
    // 原来的写法拿「全工作区花费 / 单 Agent 上限」当百分比、拿「单 Agent 上限 -
    // 全工作区花费」当剩余，于是剩余额度是没有任何 Agent 能花的数字。
    const percent = Math.round(context.budget.ratio * 100);
    const remaining = Math.max(
      0,
      context.budget.limitCents - context.budget.spentCents,
    );
    const costEfficiency = Math.max(
      0,
      Math.min(
        100,
        100 - context.budget.ratio * config.council.score.budgetPressureWeight,
      ),
    );
    stance = costEfficiency < config.council.score.base ? "oppose" : "support";
    const tightest = context.budget.tightest;
    claim =
      context.budget.limitCents > 0
        ? `议题「${topicLabel}」相关支出：各 Agent 额度合计 ${context.budget.limitCents} 分，已用 ${percent}%（${context.budget.spentCents}/${context.budget.limitCents} 分），剩余 ${remaining} 分${tightest ? `；最紧的是 ${tightest.name}（${tightest.spentCents}/${tightest.limitCents} 分）` : ""}。`
        : `议题「${topicLabel}」相关支出：本周没有设 Agent 预算上限（0 表示不设上限），已记账 ${context.budget.spentCents} 分。`;
    risk = `「${topicLabel}」若超支会挤压后续实验和资料预算。`;
    recommendation = `为「${topicLabel}」设硬上限；超过上限需二次审批。`;
    evidence = [
      {
        label: "预算执行",
        ref: `agent:${agent.id}`,
        quote:
          context.budget.limitCents > 0
            ? `${context.budget.spentCents}/${context.budget.limitCents}`
            : `${context.budget.spentCents}（无上限）`,
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
