import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { insights } from "@/lib/db/schema";
import { loadReview } from "@/server/readmodels/review";
import { resetDb } from "../helpers/db";

const DEMO_USER_ID = "usr_zhen";

/**
 * 25 条更年轻的提议把种子里的两条已采纳洞察挤出第一页：默认每页 20 条，
 * 按 createdAt 倒序。这正是"已采纳的洞察都在更早的页上"的真实形态——
 * 洞察先被提出、后被人采纳，越是生效的越老。
 */
async function buryAppliedInsights() {
  await db.insert(insights).values(
    Array.from({ length: 25 }, (_, index) => ({
      id: `ins_page_${String(index).padStart(2, "0")}`,
      userId: DEMO_USER_ID,
      claim: `把阅读时段往后挪 ${index + 1} 分钟。`,
      rationale: "测试用的成批洞察。",
      confidence: 0.5,
      evidence: [{ label: "任务", ref: "tsk_read" }],
      proposedChange: {
        type: "reschedule" as const,
        taskId: "tsk_read",
        from: "21:00",
        to: "09:00",
      },
      status: "proposed",
    })),
  );
}

beforeEach(async () => {
  await resetDb();
});

describe("review page — 已生效的变更", () => {
  it("报出的是全部已采纳洞察，而不是这一页恰好装下的那些", async () => {
    await buryAppliedInsights();
    // 「已生效」按 decided_at 归周：这条用例讲的是分页，先把种子里那两条钉在本周内，
    // 否则跨过周一零点再跑，两天前的采纳就落到上一周了。
    await db
      .update(insights)
      .set({ decidedAt: new Date() })
      .where(eq(insights.status, "applied"));

    const page = await loadReview(DEMO_USER_ID);

    // 这一页上一条已采纳的都没有——下面的断言不能靠"页里正好有"。
    expect(page.insights.some((insight) => insight.status === "applied")).toBe(false);
    expect(page.insightAppliedTotal).toBe(2);
    expect(page.appliedInsights.map((insight) => insight.id).sort()).toEqual([
      "ins_morning",
      "ins_rule",
    ]);
  });
});
