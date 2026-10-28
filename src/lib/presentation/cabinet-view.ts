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
