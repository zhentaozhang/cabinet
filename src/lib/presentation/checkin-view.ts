/**
 * 首页 check-in 卡片里那串复选框：勾上之后任务到底会不会变成「完成」。
 *
 * 只有 `accepted` 的任务能被 check-in 关掉。`saveCheckin`
 * （src/server/services/commands/checkins.ts:85-103）对每一条完成的勾选只放行
 * accepted → done 这一条迁移，其它状态原样留着、等验收；同一文件里的注释写明了
 * 理由：check-in 是自报，不是 Auditor 的判定。
 *
 * 但卡片把「推进中」的任务整串都摆成复选框（src/app/page.tsx:809-811 传的是
 * inFlightTasks），于是一个 submitted 或 planned 的任务勾上去看起来就是「做完了」，
 * 后端却什么都不改——状态还是 submitted/planned，而 checkins.completed 里已经记成
 * done，第二天「昨天的偏差」还会照这份记录数。静默无事发生，是这个仓库反复修的一类
 * 承诺：能勾的东西，就要说清勾了会发生什么。
 *
 * 这里不改状态机（自报也不算验收），只把两件事分开：哪些勾了会真的关任务，
 * 哪些勾了只记进这次 check-in。
 */

/** 唯一能被 check-in 关掉的状态（checkins.ts 的条件更新谓词）。 */
export const CHECKIN_CLOSABLE_STATUS = "accepted";

export type CheckinTaskLike = { status: string };

/**
 * 把卡片上的任务分成「勾了会完成」与「勾了只记录」两桶，顺序保持传入顺序。
 *
 * 认不出来的状态落进 reportOnly：少承诺一个会关闭的任务，比承诺一个不会关闭的好。
 */
export function checkinTaskBuckets<T extends CheckinTaskLike>(
  tasks: readonly T[],
): { closable: T[]; reportOnly: T[] } {
  const closable: T[] = [];
  const reportOnly: T[] = [];
  for (const task of tasks) {
    if (task.status === CHECKIN_CLOSABLE_STATUS) closable.push(task);
    else reportOnly.push(task);
  }
  return { closable, reportOnly };
}

const REPORT_ONLY_LABEL: Record<string, string> = {
  submitted: "待验收 · 只记录",
  auditing: "验收中 · 只记录",
};

/**
 * 某一行复选框右边的提示；能关掉的任务不写提示（勾了就是完成，不用解释）。
 *
 * 文案里的「只记录」是准确的：saveCheckin 会把这条写进 checkins.completed，
 * 但任务行的状态不动，审计链也不会多一行。
 */
export function checkinRowHint(status: string): string | null {
  if (status === CHECKIN_CLOSABLE_STATUS) return null;
  return REPORT_ONLY_LABEL[status] ?? "还没通过验收 · 只记录";
}

/**
 * 那一串「只记录」任务下面的说明；一条都没有时返回 null，不占版面。
 */
export function checkinReportOnlyNote(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  const n = Math.round(count);
  return (
    "其中 " + n +
    " 项还没通过验收：勾选只会记进这次 check-in，任务状态不会变——等 Auditor 验收通过后再勾，才会把它标记为完成。"
  );
}
