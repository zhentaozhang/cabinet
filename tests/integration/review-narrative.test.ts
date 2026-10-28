import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { regenerateWeeklyReview } from "@/server/services/commands/reviews";
import { createGoal, createTask } from "@/server/services/engine";
import { resetDb } from "../helpers/db";

async function learningTask(title: string, goalId: string) {
  return createTask(
    {
      goalId,
      title,
      description: "用自己的话讲清楚，再给一个例子。",
      assigneeId: "ag_coach",
      auditorId: "ag_auditor",
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 0,
      acceptanceCriteria: "讲清楚即可。",
      acceptanceChecklist: [{ type: "section", value: "答案", required: true }],
      estimateMin: 30,
      template: "learning",
    },
    DEMO_USER_ID,
  );
}

beforeEach(async () => {
  await resetDb();
});

/**
 * 「本周改了什么」那段叙事的两行必须指同一件事：先写「完成 N 个学习任务」，
 * 紧接着列「已验收：…」。查已验收任务时按 accepted_at 倒序，而 Postgres 的
 * DESC 默认 NULLS FIRST —— 同一周里没做完的任务一多，limit 5 全被它们占满，
 * 已验收的反而被挤出去，于是下一行变成「本周还没有验收通过的学习任务」。
 */
describe("weekly review narrative — 已验收名单", () => {
  it("列出已经验收的学习任务，即使同周还有更多没做完的", async () => {
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

    const accepted = await learningTask("解释闭包", goal.id);
    await db
      .update(tasks)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(eq(tasks.id, accepted.id));
    for (let index = 1; index <= 5; index += 1) {
      await learningTask(`待完成练习 ${index}`, goal.id);
    }

    const review = await regenerateWeeklyReview(DEMO_USER_ID);

    expect(review.narrative).toContain("已验收：解释闭包");
    expect(review.narrative).not.toContain("本周还没有验收通过的学习任务");
  });
});
