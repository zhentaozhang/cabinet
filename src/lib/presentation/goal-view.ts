/**
 * 目标进度只有学习目标是「算出来的」。
 *
 * `recalculateGoalProgress`（src/server/services/commands/progress.ts:31-40）进门
 * 先查 `goals.domain`，只要不是 `learning` 就直接 return，所以健身 / 工作 / 生活
 * 目标的 `progress` 从创建起就是 0（src/server/services/commands/goals.ts:52），
 * 种子里那个健身目标更是写死的 60（src/lib/db/seed.ts:532）。把它印成百分比，
 * 等于给一个再也不会变的数字盖上「当前进度」的名——首页的目标进度卡、页头那句
 * 主目标、都是这么来的。非学习目标在这里留「—」，并说明为什么没有数字。
 *
 * 同一件事的另一面：学习目标的进度只数 LEARNING_TEMPLATES（learning /
 * learning_retest，src/lib/domain/learning.ts:4）的验收比例、最近回忆分与本周
 * 打卡（src/server/services/commands/progress.ts:53-70），而快速创建出来的任务
 * `template` 是 null（src/server/services/commands/tasks/create.ts:170），所以
 * 「关联目标 → 计入目标进度统计」对任何目标都不成立：那条关联只解决归属，
 * 不会移动数字。
 */

const LEARNING_GOAL_DOMAIN = "learning";

/** 目标进度那一格读什么。非学习目标没有可算的数，给「—」而不是 0% 或旧值。 */
export function goalProgressText(domain: string, progress: number): string {
  if (domain !== LEARNING_GOAL_DOMAIN) return "—";
  if (!Number.isFinite(progress)) return "—";
  return Math.min(100, Math.max(0, Math.round(progress))) + "%";
}

/** 目标进度下面那句口径说明。 */
export function goalProgressHint(domain: string): string {
  return domain === LEARNING_GOAL_DOMAIN
    ? "按学习任务的验收比例、最近回忆分与本周打卡现算。"
    : "这类目标不按任务或打卡推算，所以进度留空，而不是拿一个没人再算的数字充数。";
}

/** 快速创建里「关联目标」下面那句。只记归属，不算进度。 */
export function goalLinkHint(goalId: string | null): string {
  return goalId
    ? "只记归属：进度只按学习任务的验收与打卡现算，这条任务不会改变那个数字。"
    : "未关联至任何长期目标";
}
