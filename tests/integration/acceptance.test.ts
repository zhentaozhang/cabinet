import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, tasks } from "@/lib/db/schema";
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
import { canTransition } from "@/lib/domain/state";

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
    // Without a checklist nothing was compared, so there is no verdict to give:
    // the task stops at "needs_review" for the user instead of reporting a
    // line-by-line pass that never ran.
    expect(row.status).toBe("needs_review");
    expect(row.acceptanceReport).toHaveLength(1);
    expect(row.acceptanceReport?.[0].item.type).toBe("manual");
    expect(row.acceptanceReport?.[0].undetermined).toBe(true);
    expect(row.acceptanceReport?.[0].reason).not.toContain("逐条对照通过");

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "audit.needs_review"),
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

describe("a failed acceptance attempt", () => {
  async function submittedTask() {
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
    return task;
  }

  async function failedAttempts(taskId: string) {
    return db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "task.audit_failed"),
          eq(auditEvents.target, taskId),
        ),
      );
  }

  it("honours the rollback edge in the state machine", () => {
    expect(canTransition("task", "auditing", "submitted")).toBe(true);
  });

  it("unsticks a task left in auditing and records why", async () => {
    const task = await submittedTask();
    // A row can sit here only if an earlier attempt died between the status lock
    // and the verdict. The policy layer then refuses to audit it (it is not
    // submitted), so before the rollback existed the task was stranded forever.
    await db
      .update(tasks)
      .set({ status: "auditing" })
      .where(eq(tasks.id, task.id));

    await expect(auditTask(task.id, DEMO_USER_ID)).rejects.toThrow(
      /not submitted for audit/,
    );

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.status).toBe("submitted");

    const events = await failedAttempts(task.id);
    expect(events).toHaveLength(1);
    const after = events[0].after as { status?: string; error?: string } | null;
    expect(after?.status).toBe("submitted");
    expect(after?.error).toContain("not submitted for audit");
  });

  it("writes nothing when the task never entered auditing", async () => {
    const task = await submittedTask();
    // A retired Auditor cannot decide, so the attempt fails before the status lock.
    await db
      .update(agents)
      .set({ status: "retired", lifecycleStage: "retired" })
      .where(eq(agents.id, "ag_auditor"));

    await expect(auditTask(task.id, DEMO_USER_ID)).rejects.toThrow(/retired|active/i);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.status).toBe("submitted");
    expect(await failedAttempts(task.id)).toHaveLength(0);
  });

  it("does not touch another user's task", async () => {
    const task = await submittedTask();
    await db
      .update(tasks)
      .set({ status: "auditing" })
      .where(eq(tasks.id, task.id));

    await expect(auditTask(task.id, "u_someone_else")).rejects.toThrow(/not found/i);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.status).toBe("auditing");
    expect(await failedAttempts(task.id)).toHaveLength(0);
  });
});

