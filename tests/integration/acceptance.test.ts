import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import {
  auditTask,
  createTask,
  runTask,
} from "@/server/services/engine";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("structured acceptance", () => {
  it("rejects a missing rubric, then accepts the retry once it appears", async () => {
    const task = await createTask(
      {
        title: "设计检索评估练习（含评分标准）",
        description: "设计 5 道题，覆盖 recall、precision、rerank。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        acceptanceCriteria: "5 道题；每题有参考答案；必须包含评分标准。",
        acceptanceChecklist: [
          { type: "section", value: "评分标准", required: true },
          { type: "min_words", value: 50, required: true },
        ],
        estimateMin: 30,
      },
      DEMO_USER_ID,
    );

    await runTask(task.id, DEMO_USER_ID);
    await auditTask(task.id, DEMO_USER_ID);

    let [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.status).toBe("rejected");
    expect(row.acceptanceReport?.[0].passed).toBe(false);
    expect(row.acceptanceReport?.[1].passed).toBe(true);

    await runTask(task.id, DEMO_USER_ID);
    await auditTask(task.id, DEMO_USER_ID);

    [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.status).toBe("accepted");
    expect(row.acceptanceReport?.every((item) => item.passed)).toBe(true);
  });
});
