import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { tasks, userActions } from "@/lib/db/schema";
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

  it("把上周布置、这一周才验收的学习任务算进这一周", async () => {
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

    const carried = await learningTask("解释事件循环", goal.id);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db
      .update(tasks)
      .set({
        status: "accepted",
        createdAt: eightDaysAgo,
        acceptedAt: new Date(),
      })
      .where(eq(tasks.id, carried.id));

    const review = await regenerateWeeklyReview(DEMO_USER_ID);

    // 按创建时间归周时，这道题上周那篇复盘写不出来（当时还没做完），这一周
    // 又被挡在窗外：两篇复盘都不提它。「完成」发生在验收那一刻。
    expect(review.narrative).toContain("完成 1 个学习任务");
    expect(review.narrative).toContain("已验收：解释事件循环");
  });
});

/**
 * 「管理时间」这一行原来写「约 X 分钟/天」，而 X 是这一周的合计
 * （sum(user_actions.duration_ms) / 60000，见 src/server/services/queries/metrics.ts:180-188）：
 * 把一周的总量当成一天的均值，同一句话里的单位把它放大了七倍，而且这句话会
 * 存进 reviews.narrative 被复盘页原样印出来。
 */
describe("weekly review narrative — 管理时间", () => {
  it("reports the weekly total without pretending it is a daily average", async () => {
    await db.insert(userActions).values({
      id: "ua_review_narrative",
      userId: DEMO_USER_ID,
      action: "approve",
      durationMs: 90_000,
    });

    const review = await regenerateWeeklyReview(DEMO_USER_ID);

    expect(review.narrative).toMatch(/本周管理时间约 \d+\.\d 分钟/);
    expect(review.narrative).toContain("实测");
    expect(review.narrative).not.toContain("/天");
  });
});
