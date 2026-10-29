import { describe, expect, it } from "vitest";

import {
  goalLinkHint,
  goalProgressHint,
  goalProgressText,
} from "@/lib/presentation/goal-view";

/**
 * 目标进度这块的两种说法都要和代码对得上：
 * 1. 只有学习目标会被 `recalculateGoalProgress` 现算，其余域在`progress`列上
 *    停着不动（种子里那个健身目标甚至写死 60）；
 * 2. 快速创建出来的任务 `template` 是 null，不进学习任务的分母，所以「关联目标」
 *    不会移动任何数字。
 * 为了确认会红，把 goalProgressText 的 domain 判断去掉跑一遍即可（健康目标会
 * 印出 60%），把 goalLinkHint 换回旧串则第 3 条红。
 */
describe("goal progress copy", () => {
  it("prints a percentage only for a learning goal", () => {
    expect(goalProgressText("learning", 38)).toBe("38%");
    expect(goalProgressText("learning", 137.6)).toBe("100%");
    expect(goalProgressText("learning", -4)).toBe("0%");
  });

  it("does not dress the frozen number of a non-learning goal as progress", () => {
    // goal_fitness 的 progress 是种子里写死的 60（src/lib/db/seed.ts:532），
    // 用户新建的 health/work/life 目标则永远是创建时的 0。
    expect(goalProgressText("health", 60)).toBe("—");
    expect(goalProgressText("work", 0)).toBe("—");
  });

  it("explains why a non-learning goal has no number instead of implying 0%", () => {
    const copy = goalProgressHint("health");
    expect(copy).toContain("不按任务或打卡推算");
    expect(copy).toContain("留空");
    expect(copy).not.toContain("按学习任务");
    expect(goalProgressHint("learning")).toContain("最近回忆分");
  });

  it("stops claiming that linking a goal counts toward its progress", () => {
    const linked = goalLinkHint("goal_rag");
    expect(linked).toContain("只记归属");
    expect(linked).toContain("不会改变那个数字");
    expect(linked).not.toContain("计入目标进度统计");
    expect(goalLinkHint(null)).toBe("未关联至任何长期目标");
  });
});
