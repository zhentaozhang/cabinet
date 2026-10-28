import { beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { checkins, goals } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { saveCheckin } from "@/server/services/commands/checkins";
import { resetDb } from "../helpers/db";

/**
 * 今天填了打卡、但没填回忆分，目标进度不该掉。
 *
 * 进度里的回忆分取的是"最近一条打卡"的 recall_score，而 recall_score 是可选字段：
 * 同一天的打卡再存一次、把这一栏留空，就会把昨天那个真实的 0.4 覆盖成 null，
 * 而 `computeLearningProgress` 把 null 当 0 分算。用户什么都没做错——他只是今天
 * 没再自评一次——进度却掉了一整个回忆权重。
 *
 * "没有这一栏"不是"回忆正确率 0%"，跟验收里的"没有结论 ≠ 通过"是同一条规矩：
 * 分数只在有证据时更新，没有证据时沿用最近一次已知的。
 */

async function progressOf(goalId: string): Promise<number> {
  const [row] = await db
    .select({ progress: goals.progress })
    .from(goals)
    .where(eq(goals.id, goalId));
  return row.progress;
}

beforeEach(async () => {
  await resetDb();
});

describe("打卡里的回忆分与目标进度", () => {
  it("今天的打卡没填回忆分，沿用上一次已知的分数", async () => {
    // 种子里昨天那条打卡的回忆分是 0.4。
    await saveCheckin(
      { energy: 3, mood: 3, completed: [], note: "", recallScore: 0.4 },
      DEMO_USER_ID,
    );
    const withScore = await progressOf("goal_rag");
    expect(withScore).toBeGreaterThan(0);

    // 同一天的第二次保存，回忆分留空（表单里这一栏是选填的）。
    await saveCheckin(
      { energy: 3, mood: 3, completed: [], note: "今天没再自测。" },
      DEMO_USER_ID,
    );

    expect(await progressOf("goal_rag")).toBe(withScore);
  });

  it("新填的回忆分仍然立刻生效", async () => {
    await saveCheckin(
      { energy: 3, mood: 3, completed: [], note: "", recallScore: 0.2 },
      DEMO_USER_ID,
    );
    const low = await progressOf("goal_rag");
    await saveCheckin(
      { energy: 3, mood: 3, completed: [], note: "", recallScore: 1 },
      DEMO_USER_ID,
    );
    expect(await progressOf("goal_rag")).toBeGreaterThan(low);

    const [latest] = await db
      .select({ recallScore: checkins.recallScore, date: checkins.date })
      .from(checkins)
      .where(and(eq(checkins.userId, DEMO_USER_ID)))
      .orderBy(desc(checkins.date))
      .limit(1);
    expect(latest.recallScore).toBe(1);
  });
});
