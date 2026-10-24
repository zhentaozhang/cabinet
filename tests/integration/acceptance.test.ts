import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { submitTaskArtifact } from "@/server/services/commands/tasks/submit";
import { ConflictError } from "@/lib/domain/errors";
import { and, desc } from "drizzle-orm";
import { auditEvents } from "@/lib/db/schema";
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

  it("says the comparison never happened when the task has no checklist", async () => {
    const task = await createTask(
      {
        title: "整理本周会议要点",
        description: "把三次会议的要点整理成一页纸。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        acceptanceCriteria: "三条会议要点，每条不超过 50 字。",
        estimateMin: 20,
      },
      DEMO_USER_ID,
    );
    expect(task.acceptanceChecklist).toBeNull();

    await runTask(task.id, DEMO_USER_ID);
    await auditTask(task.id, DEMO_USER_ID);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    // Without a checklist there is nothing to compare, so the verdict may still
    // be "accepted" — but the report has to say so instead of claiming a
    // line-by-line pass that never ran.
    expect(row.status).toBe("accepted");
    expect(row.acceptanceReport).toHaveLength(1);
    expect(row.acceptanceReport?.[0].item.type).toBe("manual");
    expect(row.acceptanceReport?.[0].undetermined).toBe(true);
    expect(row.acceptanceReport?.[0].reason).not.toContain("逐条对照通过");

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "audit.accept"),
          eq(auditEvents.target, task.id),
        ),
      )
      .orderBy(desc(auditEvents.seq))
      .limit(1);
    const after = event?.after as { artifactId?: string } | null;
    expect(after?.artifactId).toBeTruthy();
  });

  it("refuses a new submission once the task is being audited", async () => {
    const task = await createTask(
      {
        title: "整理本周会议要点",
        description: "把三次会议的要点整理成一页纸。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        acceptanceCriteria: "三条会议要点。",
        estimateMin: 20,
      },
      DEMO_USER_ID,
    );
    await runTask(task.id, DEMO_USER_ID);

    // The audit locks the row into `auditing` before it reads the draft, which
    // is what makes "what was judged" equal "what was recorded".
    await db
      .update(tasks)
      .set({ status: "auditing" })
      .where(eq(tasks.id, task.id));

    await expect(
      submitTaskArtifact({ taskId: task.id, content: "替换稿" }, DEMO_USER_ID),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
