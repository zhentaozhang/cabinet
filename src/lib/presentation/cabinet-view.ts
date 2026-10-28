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

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
