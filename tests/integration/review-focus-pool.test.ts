import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { pickFocusTask } from "@/lib/presentation/review-view";
import { loadReview } from "@/server/readmodels/review";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

/**
 * 「下周的唯一目标」原来在「最近更新的 200 条任务」里挑：任务多的工作区里，一条更早、
 * 优先级更高的未收尾任务会被新近收尾的任务挤出窗口，页面就印「没有未收尾的任务」。
 * 现在任务池只含未收尾的任务，顺序与 pickFocusTask 一致。
 */
describe("weekly review — 下周目标的任务池", () => {
  it("keeps an old open task that 200 newer closed tasks would have pushed out", async () => {
    const now = new Date();
    const longAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);

    await db.insert(tasks).values(
      Array.from({ length: 200 }, (_, index) => ({
        id: `tsk_closed_${String(index).padStart(3, "0")}`,
        userId: DEMO_USER_ID,
        title: `早就收尾的练习 ${index + 1}`,
        description: "测试用：占满最近更新的窗口。",
        status: "done" as const,
        priority: 1,
        acceptanceCriteria: "做完即可。",
        createdAt: longAgo,
        updatedAt: now,
      })),
    );
    await db.insert(tasks).values({
      id: "tsk_stale_open",
      userId: DEMO_USER_ID,
      title: "四十天前安排、一直没动的那件事",
      description: "测试用：更早更新、但仍然没收尾。",
      status: "planned",
      priority: 1,
      acceptanceCriteria: "做完即可。",
      createdAt: longAgo,
      updatedAt: longAgo,
    });

    const page = await loadReview(DEMO_USER_ID);

    // 关键断言：这条任务在「最近更新的 200 条」里排不进去，但它是未收尾的，
    // 所以必须留在池子里，页面才不会说「没有未收尾的任务」。
    expect(page.tasks.map((task) => task.id)).toContain("tsk_stale_open");
    // 池子里不该再出现收尾的任务——否则 200 条历史会把窗口重新挤满。
    expect(page.tasks.every((task) => task.status !== "done")).toBe(true);
    expect(pickFocusTask(page.tasks)).toBeDefined();
  });
});
