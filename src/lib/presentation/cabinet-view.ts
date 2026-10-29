import { passRate } from "@/contracts/labels";

/**
 * The Cabinet card footer counts the tasks each Agent has carried.
 *
 * It used to skip `done` and nothing else, so an Agent whose work had all been
 * finished read "0 个任务" next to "10 次通过": the filter described one thing
 * ("未结") while the label described another ("个任务"), and neither matched a
 * row the reader could check. Every task the Agent is the assignee of counts,
 * whatever its status, because the two numbers beside it are totals as well.
 */
export function tasksPerAgent(
  tasks: ReadonlyArray<{ assigneeId: string | null }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (!task.assigneeId) continue;
    counts.set(task.assigneeId, (counts.get(task.assigneeId) ?? 0) + 1);
  }
  return counts;
}
/**
 * 制度栏的第三句：连续驳回几次会发生什么。
 *
 * 这句话原本是写死的「连续 2 次驳回 → 换人或进入退休评估」，两处都不对：
 * 那个 2 是 `audit.rejectStreakLimit` 的默认值，而它在洞察的覆盖白名单里
 * （`src/lib/policy/overrides.ts`，1–20），用户把上限调到 5 之后这句话就在
 * 承诺一个后端不执行的阈值；而且代码里既没有「换人」也没有自动退休评估——
 * `src/server/services/commands/tasks/audit.ts` 做的是把 Agent 置为 paused，
 * 记一条 `agent.paused`（reason=reject_streak_limit），等用户决定；复盘页的
 * 「考虑退休」是另一个判据（驳回次数多于通过次数），与这个上限无关。
 */
export function escalationPolicyLine(rejectStreakLimit: number): string {
  const limit = Number.isFinite(rejectStreakLimit)
    ? Math.max(1, Math.trunc(rejectStreakLimit))
    : 1;
  return `连续驳回 ${limit} 次 → 暂停这个 Agent，等你决定重新启用还是退休。所有记录进入哈希链审计日志。`;
}

export type AgentHeadcount = {
  total: number;
  onDuty: number;
  growing: number;
  retired: number;
};

/**
 * The Cabinet header reads "N 个 Agent · X 在岗 · Y 成长中".
 *
 * "成长中" used to be `lifecycleStage !== "active"`, which also matches a
 * retired Agent: `retireAgent` writes status="retired" *and*
 * lifecycleStage="retired", so the page counted someone who had left the org
 * as still growing while the card below them showed the badge 已退休.
 * Retired Agents are counted on their own and never as 成长中.
 */
export function agentHeadcount(
  agents: ReadonlyArray<{ status: string; lifecycleStage: string }>,
): AgentHeadcount {
  let onDuty = 0;
  let growing = 0;
  let retired = 0;
  for (const agent of agents) {
    const isRetired =
      agent.status === "retired" || agent.lifecycleStage === "retired";
    if (isRetired) {
      retired += 1;
      continue;
    }
    if (agent.status === "active") onDuty += 1;
    if (agent.lifecycleStage !== "active") growing += 1;
  }
  return { total: agents.length, onDuty, growing, retired };
}
export type UpgradeRequirements = {
  minTrust: number;
  minSuccesses: number;
  minAuditSamples: number;
  minAuditPassRate: number;
};

/**
 * 授权控制卡下面那行「升级需要：…」。
 *
 * 原文写死「信任分 ≥70 · 成功任务 ≥3 · 有效审计样本 ≥5 · 非试用期」——四个数字
 * 是 `config.autonomy` 的默认值，而且漏了最后一个真正的门槛：
 * `src/lib/domain/policy.ts` 的 `decideUpgrade` 还会要求审计通过率
 * ≥ `config.autonomy.minAuditPassRate`（默认 0.9）。也就是说有人把这四条全
 * 做到、通过率只有一半时，升级会被拒，而页面从没提过这一条。
 *
 * 门槛全部来自调用方传入的配置值，不再有一份和代码并行的副本。
 */
export function upgradeRequirementsLine(input: UpgradeRequirements): string {
  const trust = Math.max(0, Math.round(finiteOr(input.minTrust, 0)));
  const successes = Math.max(0, Math.round(finiteOr(input.minSuccesses, 0)));
  const samples = Math.max(0, Math.round(finiteOr(input.minAuditSamples, 0)));
  const rate = Math.round(
    Math.min(1, Math.max(0, finiteOr(input.minAuditPassRate, 1))) * 100,
  );
  return `升级需要：信任分 ≥${trust} · 成功任务 ≥${successes} · 有效审计样本 ≥${samples} · 审计通过率 ≥${rate}% · 非试用期。`;
}

/**
 * 绩效卡上的通过率。
 *
 * 没有判定过的时候不能印 0%：0/0 不是一个比例，而这行字旁边写着「验收通过率」，
 * 读起来就是「一次都没过」。复盘页（src/app/review/page.tsx）早就按这个口径写
 * 「还没有验收记录」，Agent 详情页却仍然印 0%——同一个数在两页上说法不一致，
 * 也违背「没有证据就写未判定」：没判过就没有通过率可报。
 */
export type PassRateReadout = {
  /** 「75%」，或没有判定记录时的「—」。 */
  value: string;
  hint: string;
};

export function agentPassRate(input: {
  successCount: number;
  failCount: number;
}): PassRateReadout {
  const success = Math.max(0, Math.round(finiteOr(input.successCount, 0)));
  const fail = Math.max(0, Math.round(finiteOr(input.failCount, 0)));
  if (success + fail === 0) {
    return { value: "—", hint: "还没有验收记录" };
  }
  return { value: `${passRate(success, fail)}%`, hint: "验收通过率" };
}

/** 只做 ¥X.XX：这一层不引 UI 工具（src/lib/format.ts 的 money 会带进 clsx）。 */
function yuan(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

/**
 * 「Weekly budget (¥)」输入框下面那行字。
 *
 * 框里填 0 不是「这个 Agent 不许花钱」。真正的判据是 periodLimitCents
 * （src/lib/domain/agent-budget.ts:35-42）：
 * `agentBudgetCents > 0 ? min(该值, 策略默认上限) : 策略默认上限`——
 * 0 表示**不单独设上限**、只受部署级 budget.weeklyLimitCents 约束，也就是最宽的
 * 那个额度，正好和「填 0 让人别花钱」的直觉相反。这不是边角情况：
 * src/contracts/templates.ts 里 7 个角色有 4 个（chief / treasurer / auditor /
 * critic）budgetCents 就是 0，新建工作区（src/lib/setup.ts:140 直接抄模板）
 * 之后输入框显示「0」，同一页的绩效卡却印着「上限 ¥600.00」。
 *
 * 更糟的是提交那一步：清空输入框后 `Number("") === 0`，保存下去正好落进
 * 这个最宽的分支——以为是「清掉」，实际是「放到最大」。所以框下面必须写清楚
 * 0 的含义，提交也必须走 yuanToCents 的空值判定（见 agent-actions.tsx）。
 */
export function weeklyBudgetFieldHint(input: {
  budgetCents: number;
  limitCents: number;
}): string {
  const typed = finiteOr(input.budgetCents, 0);
  const limit = finiteOr(input.limitCents, 0);
  if (typed <= 0) {
    return `填 0 不是「不许花」：等于不单独给这个 Agent 设上限，跟着部署的策略默认上限走——这一周它的上限是 ${yuan(limit)}。`;
  }
  if (limit < typed) {
    return `这一周的上限是 ${yuan(limit)}：部署的策略默认上限比填的数低，按更低的那条走。`;
  }
  return `这一周的上限是 ${yuan(limit)}：填的数低于策略默认上限时按你填的算。`;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
/**
 * 学徒卡片上那两个入口（记录观摩、运行结业考试）还能不能出现。
 *
 * 判断只由 `agents.lifecycle_stage` 决定。页面原来写的是「不等于 active 且不等于
 * practice_passed」就显示——于是 retired 的学徒页上仍然摆着两个按钮：
 * `recordApprenticeObservation` 对已退休的学徒直接抛「已退休的学徒不能再记录观摩。」
 * （src/server/services/commands/apprentice.ts:87-92），`runApprenticeExam` 抛
 * 「Apprentice is retired and cannot take the exam.」（同文件 :184-186）。点哪个都只会
 * 拿到一句报错，按钮承诺的动作后端一律不做；同一段下面的「记录满 N 条才能参加考试」
 * 也已经是句空话。转正之后（active）同理：技能已是 v1，考试不再有意义。
 */
export function apprenticeTrainingOpen(stage: string): boolean {
  return stage !== "active" && stage !== "practice_passed" && stage !== "retired";
}

/** 已退休的学徒在「学徒转正」卡里该看到的话：没有下一步动作，也别再等考试。 */
export const APPRENTICE_RETIRED_NOTICE =
  "已退休：这个学徒不再接单，观摩记录与结业考试都已关闭。";
