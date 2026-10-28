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
