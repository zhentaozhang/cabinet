import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { goals } from "@/lib/db/schema";
import { getPolicyConfigFor } from "@/lib/policy/config";
import { recalculateGoalProgress } from "@/server/services/commands/progress";
import { resetDb } from "../helpers/db";

const DEMO_USER_ID = "usr_zhen";

async function progressOf(goalId: string): Promise<number> {
  const [row] = await db
    .select({ progress: goals.progress })
    .from(goals)
    .where(eq(goals.id, goalId));
  return Number(row.progress);
}

describe("demo seed", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // 学习目标的进度是派生值：任务通过比例 + 本周打卡数 + 最近回忆分。
  // 种子若写死一个好看的数字，用户第一次打卡就会看到进度掉下来——那次打卡
  // 会按公式重算，而重算的依据从来不是那个数字。演示数据必须自己站得住。
  it("seeds the learning goal at the number the formula computes", async () => {
    const seeded = await progressOf("goal_rag");

    const config = await getPolicyConfigFor(DEMO_USER_ID);
    await db.transaction((tx) =>
      recalculateGoalProgress(tx, DEMO_USER_ID, "goal_rag", config.learning),
    );

    expect(await progressOf("goal_rag")).toBe(seeded);
  });
});
