import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { goals } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { getWeeklyMetrics } from "@/server/services/queries/metrics";
import { regenerateWeeklyReview } from "@/server/services/commands/reviews";
import { resetDb } from "../helpers/db";

/**
 * 周复盘里的"目标进度"报的是哪个目标。
 *
 * 种子数据里同时有两个活跃目标（学习 38%、健康 60%），而打卡 / 回忆分 /
 * 学习任务 / 复测通过率这一整组数字都是学习口径。原来的查询是
 * `where status = 'active' limit 1`——没有 order by，报哪一个是数据库
 * 的物理顺序决定的，同一周重新生成一次就可能换成另一个目标的数字。
 */
describe("周复盘的目标进度", () => {
  it("报学习目标，而不是数据库先扫到的那一个", async () => {
    await resetDb();
    // 把两个目标的口径对调：学习目标变成种子里的健康目标（60%），
    // 健康目标变成 38%。只按"随便取一个活跃目标"实现的话，这里会读到 38。
    await db
      .update(goals)
      .set({ domain: "health" })
      .where(eq(goals.id, "goal_rag"));
    await db
      .update(goals)
      .set({ domain: "learning" })
      .where(eq(goals.id, "goal_fitness"));

    const weekly = await getWeeklyMetrics(DEMO_USER_ID);

    expect(weekly.goalProgress).toBe(60);
  });

  it("没有学习目标时报空，而不是 0%", async () => {
    await resetDb();
    await db.update(goals).set({ domain: "health" });

    const weekly = await getWeeklyMetrics(DEMO_USER_ID);

    expect(weekly.goalProgress).toBeNull();

    const review = await regenerateWeeklyReview(DEMO_USER_ID);
    expect(review.narrative).not.toContain("目标进度");
  });
});
