import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { goals, tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { getPolicyConfigFor } from "@/lib/policy/config";
import { createGoal, createTask } from "@/server/services/engine";
import { recalculateUserGoalProgress } from "@/server/services/commands/progress";
import { cancelTask } from "@/server/services/commands/tasks/cancel";
import { resetDb } from "../helpers/db";

/**
 * 取消一个从未做过的学习任务，进度应该回到"它还不存在"时的数值。
 *
 * 这里藏着两个各自独立的原因：
 *   1. 分母把 cancelled 也算成"一个该通过却没通过的任务"，而 cancel 是终态，
 *      永远补不回来 —— 进度被一封已撤回的任务永久按住；
 *   2. cancel 改了任务状态，却没有触发重算，于是即便分母规则是对的，
 *      页面上的数字也要等到下一次无关事件（打卡、出题）才纠正。
 */

async function progressOf(goalId: string): Promise<number> {
  const [row] = await db
    .select({ progress: goals.progress })
    .from(goals)
    .where(eq(goals.id, goalId));
  return row.progress;
}

async function recompute(goalId: string): Promise<number> {
  const config = await getPolicyConfigFor(DEMO_USER_ID);
  await db.transaction((tx) =>
    recalculateUserGoalProgress(tx, DEMO_USER_ID, config.learning),
  );
  return progressOf(goalId);
}

beforeEach(async () => {
  await resetDb();
});

describe("取消学习任务与目标进度", () => {
  it("取消的任务不进分母，取消当场重算", async () => {
    const goal = await createGoal(
      {
        title: "掌握 JS 运行时",
        why: "想把异步这块补扎实",
        target: "能讲清事件循环",
        horizon: "3 个月",
        domain: "learning",
      },
      DEMO_USER_ID,
    );

    const done = await createTask(
      {
        goalId: goal.id,
        title: "解释事件循环",
        description: "用自己的话说清微任务与宏任务的先后。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        acceptanceCriteria: "讲清微任务先于宏任务。",
        estimateMin: 30,
        template: "learning",
      },
      DEMO_USER_ID,
    );
    // 这一条已经通过：直接用状态 + 重算建立基线，本条用例考的是另一条任务的取消。
    await db
      .update(tasks)
      .set({ status: "accepted" })
      .where(eq(tasks.id, done.id));
    const baseline = await recompute(goal.id);
    expect(baseline).toBeGreaterThan(0);

    const dropped = await createTask(
      {
        goalId: goal.id,
        title: "回炉练习：事件循环",
        description: "重复题。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        acceptanceCriteria: "讲清微任务先于宏任务。",
        estimateMin: 30,
        template: "learning_retest",
      },
      DEMO_USER_ID,
    );
    // 新建任务进了分母，进度按设计下降。
    expect(await progressOf(goal.id)).toBeLessThan(baseline);

    await cancelTask(dropped.id, DEMO_USER_ID, "重复题，不做了。");

    // 1) 取消当场就要纠正，而不是等下一次打卡。
    expect(await progressOf(goal.id)).toBe(baseline);
    // 2) 再算一遍也一样：cancelled 不在分母里。
    expect(await recompute(goal.id)).toBe(baseline);
  });
});
