import { and, desc, eq, gte, inArray } from "drizzle-orm";
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
import { logAuditTx } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { getPolicyConfigFor } from "@/lib/policy/config";
import type { PolicyConfig } from "@/lib/domain/policy";
import { loadWeeklyUsage } from "./tasks/execution";
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

export type ReflectionCandidate = {
  claim: string;
  rationale: string;
  confidence: number;
  evidence: Evidence[];
  proposedChange: ProposedChange;
};

/**
 * 驳回率到"该动策略"的阈值。刻意是常量而不是 policy_config 的键：如果它本身
 * 可被洞察覆盖，一条"驳回太多"的洞察就能自己调低触发门槛，形成自我放行的
 * 回路。
 */
export const REJECT_RATE_ACTION_THRESHOLD = 0.5;

/** 降粒度时按当前值打折；一次只降一档，避免把要求直接打到地板上。 */
const POLICY_PROPOSAL_WORD_FACTOR = 0.8;

/** 与 REFLECTION 里的其它常量一致：低于 20 字的任务描述无法验收。 */
const POLICY_PROPOSAL_MIN_WORDS_FLOOR = 20;

export const POLICY_PROPOSAL_KEY = "learning.nextTask.minWords";

/**
 * 驳回率体检 → 一条真能落地的策略变更提议。
 *
 * 为什么只做"降低 nextTask.minWords"：驳回集中在"内容不达标"时，最直接的
 * 变量是任务粒度；把最少字数要求调低能让下一批任务变小、更快拿到验收反馈。
 * 其它旋钮（信任门槛、预算上限）属于安全底线，不在白名单里，这里也不提。
 *
 * 为什么是纯函数：这条规则最容易写错（阈值方向、等值、无证据），抽出来就能
 * 在单测里把边界钉死，不必造一整套审计数据。
 */
export function policyProposalForRejectionRate(input: {
  rejectCount: number;
  auditCount: number;
  windowDays: number;
  config: PolicyConfig;
  latestReject: { id: string; reason: string } | null;
}): ReflectionCandidate | null {
  const { rejectCount, auditCount, windowDays, config, latestReject } = input;
  // 没有可引用的驳回事件就没有证据；按仓库约定，无证据不下结论。
  if (!latestReject) return null;
  if (rejectCount <= 0 || auditCount <= 0) return null;
  // 单次驳回不等于系统性偏差，要求达到连续驳回上限才动策略。
  if (rejectCount < config.audit.rejectStreakLimit) return null;
  const rate = rejectCount / Math.max(auditCount, rejectCount);
  if (rate < REJECT_RATE_ACTION_THRESHOLD) return null;

  const current = config.learning.nextTask.minWords;
  const target = Math.max(
    POLICY_PROPOSAL_MIN_WORDS_FLOOR,
    Math.round(current * POLICY_PROPOSAL_WORD_FACTOR),
  );
  // 已经是地板值或降不动了：重复提一条"和现值相同"的变更只会制造噪音。
  if (target >= current) return null;

  return {
    claim: `最近 ${windowDays} 天审计判定 ${auditCount} 次、驳回 ${rejectCount} 次（${Math.round(
      rate * 100,
    )}%）；建议把下一任务的最少字数从 ${current} 降到 ${target}，先用更小的任务把验收通过率拉回来。`,
    rationale: `按 audit.accept / audit.reject 统计：${windowDays} 天内 ${auditCount} 次验收判定中驳回 ${rejectCount} 次，驳回率 ${Math.round(
      rate * 100,
    )}% 达到触发阈值 ${Math.round(
      REJECT_RATE_ACTION_THRESHOLD * 100,
    )}%，且不低于连续驳回上限 ${config.audit.rejectStreakLimit}。任务粒度是这里唯一可控的变量：把 learning.nextTask.minWords 从 ${current} 调到 ${target} 会让下一批任务更小、更快拿到验收反馈。这是一条用户级覆盖，不改全局默认，随时可回滚。`,
    confidence: config.reflection.confidence,
    evidence: [
      {
        label: `审计驳回 ×${rejectCount}`,
        ref: `audit:${latestReject.id}`,
        quote: short(latestReject.reason),
      },
    ],
    proposedChange: {
      type: "set_policy",
      key: POLICY_PROPOSAL_KEY,
      value: target,
      reason: `驳回率 ${Math.round(rate * 100)}%：先降低任务粒度要求，用更小的任务恢复验收通过率。`,
    },
  };
}

export async function runReflection(
  userId: string,
): Promise<typeof insights.$inferSelect | null> {
  const { user, profile } = await getWorkspace(userId);
  // 用"这个用户生效中的策略"（全局 + 本人覆盖）而不是全局默认：否则采纳过的
  // 覆盖对反思不可见，同一条建议会被反复提出来。
  const config = await getPolicyConfigFor(userId);
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
  // 驳回率的分母是"验收判定总数"，只数 audit.reject 会得到 100% 的假象。
  const recentAuditVerdicts = await db
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.userId, userId),
        inArray(auditEvents.action, ["audit.accept", "audit.reject"]),
        gte(auditEvents.createdAt, since),
      ),
    );

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

  // 撤回的晚间任务不算「没完成」：分母里混进一条自己撤销的任务，完成率就永远
  // 差这一块，洞察会一直建议把晚上的事挪到早上。下面挑候选时本来就排除了
  // cancelled，两处口径必须一致（复盘页的计划遵从率、目标进度也是这么算的）。
  const eveningTasks = recentTasks.filter(
    (task) =>
      task.dueAt &&
      task.status !== "cancelled" &&
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

  // Budget pressure reads the weekly ledger; unused reservations are reported
  // separately and never merged into settled spend.
  const weeklyUsage = await Promise.all(
    allAgents.map((agent) => loadWeeklyUsage(agent.id, user.timezone)),
  );
  const spentCents = weeklyUsage.reduce(
    (sum, usage) => sum + usage.settledCents + usage.unknownCents,
    0,
  );
  const reservedCents = weeklyUsage.reduce(
    (sum, usage) => sum + usage.reservedCents,
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
        rationale: `按周预算台账汇总（已结算 ${spentCents} 分，未结算预留 ${reservedCents} 分），预算上限 ${config.budget.weeklyLimitCents} 分；触发阈值 ${Math.round(
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

  // 这条候选放在最后：前面几条是"改文案/改单个任务"，这条会真正改运行时策略，
  // 优先级最低。只有驳回率明显偏高时才出现。
  const policyProposal = policyProposalForRejectionRate({
    rejectCount: recentRejects.length,
    auditCount: recentAuditVerdicts.length,
    windowDays: config.reflection.windowDays,
    config,
    latestReject: recentRejects[0]
      ? {
          id: recentRejects[0].id,
          reason: String(
            recentRejects[0].after?.reason ?? "验收标准未满足",
          ).trim(),
        }
      : null,
  });
  if (policyProposal) candidates.push(policyProposal);

  for (const candidate of candidates) {
    const [existing] = await db
      .select()
      .from(insights)
      .where(
        and(eq(insights.userId, userId), eq(insights.claim, candidate.claim)),
      )
      .limit(1);
    if (existing) continue;

    return db.transaction(async (tx) => {
      const [created] = await tx
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

      await logAuditTx(tx, {
        userId,
        actor: "agent:coach",
        action: "insight.propose",
        target: created.id,
        before: null,
        after: {
          claim: created.claim,
          confidence: created.confidence,
          evidenceRefs: candidate.evidence
            .map((item) => item.ref)
            .filter(Boolean),
        },
      });
      return created;
    });
  }

  return null;
}
