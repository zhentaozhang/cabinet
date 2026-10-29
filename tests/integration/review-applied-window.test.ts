import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { insights } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { addLocalDays } from "@/lib/domain/time";
import { getReviewData } from "@/server/services/queries/review";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

/**
 * 复盘页那张卡写的是「本周改了什么」，所以「已生效」必须按采纳那一刻归周
 * （`insights.decided_at`）。原来说的是整张表里 status = 'applied' 的行：三周前
 * 采纳的一条会永远列在这里，而「本周没有已生效的变更」那句从此不会出现。
 */
describe("weekly review — 已生效的变更按周归", () => {
  it("只数这一周采纳的洞察，上周采纳的不再冒充本周的变更", async () => {
    // 种子里已经有一条 applied 的洞察，可能正好落在本周；先清空，断言才有唯一答案。
    await db.delete(insights).where(eq(insights.userId, DEMO_USER_ID));

    const stale = addLocalDays(new Date(), -21, "Asia/Shanghai");
    await db.insert(insights).values([
      {
        id: "ins_applied_stale",
        userId: DEMO_USER_ID,
        claim: "三周前采纳的那条规则",
        rationale: "测试用。",
        confidence: 0.7,
        evidence: [{ label: "打卡", ref: "checkin:chk_seed", quote: "energy 3/5" }],
        proposedChange: { type: "add_rule", rule: "先给例子，再给定义" },
        status: "applied",
        createdAt: stale,
        decidedAt: stale,
      },
      {
        id: "ins_applied_now",
        userId: DEMO_USER_ID,
        claim: "这一周采纳的那条规则",
        rationale: "测试用。",
        confidence: 0.7,
        evidence: [{ label: "打卡", ref: "checkin:chk_seed", quote: "energy 4/5" }],
        proposedChange: { type: "add_rule", rule: "讲解先给结论" },
        status: "applied",
        createdAt: stale,
        decidedAt: new Date(),
      },
    ]);

    const data = await getReviewData(DEMO_USER_ID);

    expect(data.appliedInsights.map((row) => row.id)).toEqual(["ins_applied_now"]);
    expect(data.insightAppliedTotal).toBe(1);
  });
});
