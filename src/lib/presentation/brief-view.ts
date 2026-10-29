/**
 * 早报正文里「目标」「今天有 N 个待推进任务」「建议顺序」这三行的口径。
 *
 * 这些问题都曾经真实存在，而且都发生在同一处：`regenerateBrief`
 * （src/server/services/commands/brief.ts）自己抄了一份更粗的算法，首页那条兜底早报
 * （src/app/page.tsx 里 `data.brief ?? ...` 的模板）用另一份，于是点一次「重新生成早报」，
 * 存下来的正文就和同一屏的页头 / 目标卡对不上了：
 *  - 目标进度：首页只印 `activeGoals`（暂停、完成、归档的目标不像当前方向），并且用
 *    `goalProgressText` 把非学习目标的百分比换成「—」，因为 `recalculateGoalProgress`
 *    （src/server/services/commands/progress.ts:31-40）只算 learning 域，种子里那个健身
 *    目标的 60 更是写死的（src/lib/db/seed.ts:532）。早报却把每个目标、包括暂停的和
 *    永远不会变的那个，都印成「标题（N%）」。
 *  - 待推进任务数：`getTodayData().tasks` 是**全部**未了结任务，`failed` 与
 *    `awaiting_approval` 也在里面，它们等的是人不是进展；首页用 `inFlightTasks` 取子集
 *    （src/lib/presentation/today-view.ts:205），早报数的却是整张表。
 *  - 建议顺序：早报直接 `data.tasks.slice(0, 3)`，会把一条已经失败的任务排进「先做这个」。
 *
 * 两份口径只能有一份，所以搬到这里：首页的兜底早报与 regenerateBrief 都调这三个函数。
 */

import { goalProgressText } from "@/lib/presentation/goal-view";
import { inFlightTasks } from "@/lib/presentation/today-view";

type BriefGoal = {
  title: string;
  domain: string;
  progress: number;
  status: string;
};

type BriefTask = { status: string; title: string; estimateMin: number };

/**
 * 早报开头那句「目标：…」。
 *
 * 只列 `active` 的目标：暂停 / 完成 / 归档的目标留在列表里是为了能找回来，不是当前方向。
 * 一个进行中的都没有时写「没有进行中的目标」，而不是留一个空冒号或者搬一个停掉的目标。
 */
export function briefGoalLine(goals: readonly BriefGoal[]): string {
  const active = goals.filter((goal) => goal.status === "active");
  if (active.length === 0) return "没有进行中的目标";
  return active
    .map((goal) => [goal.title, "（", goalProgressText(goal.domain, goal.progress), "）"].join(""))
    .join(" · ");
}

/**
 * 早报里那句任务数。数字与首页页头、早报徽章的「基于 N 个任务」是同一个子集：
 * 只在推进中的任务（`inFlightTasks`），不含失败和等审批的。
 */
export function briefTaskLine(tasks: readonly BriefTask[]): string {
  const count = inFlightTasks(tasks).length;
  return count > 0
    ? ["今天有 ", String(count), " 个待推进任务，优先处理已提交待验收的。"].join("")
    : "今天没有待推进任务，适合复盘或补弱项。";
}

/**
 * 「建议顺序」那几条。同样只从推进中的任务里取，否则一条已经失败的任务会被排进
 * 「先做这个」——`inFlightTasks` 的注释里明说了失败的任务不能再被推荐成下一步。
 */
export function briefOrderList(tasks: readonly BriefTask[], limit = 3): string[] {
  return inFlightTasks(tasks)
    .slice(0, limit)
    .map((task, index) => [String(index + 1), ". ", task.title, "（", String(task.estimateMin), " 分钟）"].join(""));
}

export type BriefFreshness = {
  stale: boolean;
  label: string;
  note: string;
};

/**
 * 首页「今天的关键判断」那张卡取的是最近一份每日早报（src/server/services/queries/
 * today.ts:76-81 只按 type = 'daily' 取最新一条），而 `regenerateBrief` 写的是「生成
 * 那一刻」的本地日期（src/server/services/commands/brief.ts:52 的 period:
 * localDateKey(now, timezone)，reviews 按 (userId, type, period) 唯一）。跨天之后没人
 * 点「重新生成早报」，卡里躺的还是昨天（或更早）的正文，标题却写着「今天的关键判断」，
 * 角落那个「生成于 …」只印时刻，读起来像今天早上刚生成。
 *
 * 没日期标记的一条也按「上一份」处理：无法证明它是今天的，就不能替它声称。
 */
export function briefFreshness(input: {
  period: string | null | undefined;
  todayKey: string;
}): BriefFreshness {
  const period =
    typeof input.period === "string" && input.period.length > 0
      ? input.period
      : null;
  if (period === input.todayKey) {
    return { stale: false, label: "", note: "" };
  }
  const tail = `正文里的数字是那时的快照，点右上角重新生成才会按现在的任务重写。`;
  return {
    stale: true,
    label: period ? `上一份早报 · ${period}` : "上一份早报",
    note: period
      ? `这条早报是 ${period} 生成的，今天（${input.todayKey}）还没有重新生成：${tail}`
      : `这条早报没有日期标记，今天（${input.todayKey}）还没有重新生成：${tail}`,
  };
}