import { beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkins, runJobs, runs, steps, tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { enqueueRun } from "@/server/services/commands/tasks/jobs";
import { resetDb } from "../helpers/db";

const TASK_ID = "tsk_constraints";
const RUN_ID = "run_constraints";

beforeEach(async () => {
  await resetDb();
  await db.insert(tasks).values({
    id: TASK_ID,
    userId: DEMO_USER_ID,
    title: "约束测试",
    description: "验证数据库约束。",
    assigneeId: "ag_coach",
    auditorId: "ag_auditor",
    status: "planned",
    acceptanceCriteria: "约束生效。",
    estimateMin: 10,
    actionType: "internal",
    resource: "task",
  });
});

async function insertRun(): Promise<void> {
  await db.insert(runs).values({
    id: RUN_ID,
    taskId: TASK_ID,
    agentId: "ag_coach",
    status: "succeeded",
    mode: "demo",
  });
}

describe("database constraints", () => {
  it("rejects a task whose assignee and auditor are the same", async () => {
    await expect(
      db.insert(tasks).values({
        id: "tsk_invalid_self_audit",
        userId: DEMO_USER_ID,
        title: "Invalid",
        description: "self audit",
        assigneeId: "ag_coach",
        auditorId: "ag_coach",
        status: "planned",
        acceptanceCriteria: "none",
        estimateMin: 25,
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        createdBy: "test",
      }),
    ).rejects.toThrow();
  });

  it("rejects negative estimated cost", async () => {
    await expect(
      db.insert(tasks).values({
        id: "tsk_invalid_cost",
        userId: DEMO_USER_ID,
        title: "Invalid",
        description: "negative cost",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        status: "planned",
        acceptanceCriteria: "none",
        estimateMin: 25,
        actionType: "internal",
        resource: "task",
        estimatedCostCents: -1,
        createdBy: "test",
      }),
    ).rejects.toThrow();
  });

  it("rejects two steps with the same (run, idx)", async () => {
    await insertRun();
    await db.insert(steps).values({
      id: "stp_first",
      runId: RUN_ID,
      idx: 1,
      type: "context",
      input: { n: 1 },
      output: { ok: true },
    });

    await expect(
      db.insert(steps).values({
        id: "stp_duplicate_seq",
        runId: RUN_ID,
        idx: 1,
        type: "context",
        input: { n: 2 },
        output: { ok: true },
      }),
    ).rejects.toThrow();
  });

  it("keeps the same idx usable across different runs", async () => {
    await insertRun();
    await db.insert(runs).values({
      id: "run_constraints_other",
      taskId: TASK_ID,
      agentId: "ag_coach",
      status: "succeeded",
      mode: "demo",
    });

    await db.insert(steps).values({
      id: "stp_run_a",
      runId: RUN_ID,
      idx: 1,
      type: "context",
      input: {},
      output: {},
    });
    await db.insert(steps).values({
      id: "stp_run_b",
      runId: "run_constraints_other",
      idx: 1,
      type: "context",
      input: {},
      output: {},
    });

    const rows = await db
      .select()
      .from(steps)
      .where(inArray(steps.runId, [RUN_ID, "run_constraints_other"]));
    expect(rows).toHaveLength(2);
  });

  it("rejects a second active job for the same task", async () => {
    await db.insert(runJobs).values({
      id: "job_first",
      userId: DEMO_USER_ID,
      taskId: TASK_ID,
      status: "queued",
    });

    await expect(
      db
        .insert(runJobs)
        .values({
          id: "job_second",
          userId: DEMO_USER_ID,
          taskId: TASK_ID,
          status: "running",
        }),
    ).rejects.toThrow();
  });

  it("allows a new job once the previous one finished", async () => {
    await db.insert(runJobs).values({
      id: "job_done",
      userId: DEMO_USER_ID,
      taskId: TASK_ID,
      status: "succeeded",
      finishedAt: new Date(),
    });

    await db.insert(runJobs).values({
      id: "job_next",
      userId: DEMO_USER_ID,
      taskId: TASK_ID,
      status: "queued",
    });

    const rows = await db
      .select()
      .from(runJobs)
      .where(eq(runJobs.taskId, TASK_ID));
    expect(rows).toHaveLength(2);
  });

  it("lets a queued insert lose to the active job instead of failing", async () => {
    await db.insert(runJobs).values({
      id: "job_holder",
      userId: DEMO_USER_ID,
      taskId: TASK_ID,
      status: "queued",
    });

    const inserted = await db
      .insert(runJobs)
      .values({
        id: "job_loser",
        userId: DEMO_USER_ID,
        taskId: TASK_ID,
        status: "queued",
      })
      .onConflictDoNothing({
        target: runJobs.taskId,
        where: sql`${runJobs.status} in ('queued', 'running')`,
      })
      .returning({ id: runJobs.id });

    expect(inserted).toHaveLength(0);
    const rows = await db
      .select()
      .from(runJobs)
      .where(eq(runJobs.taskId, TASK_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("job_holder");
  });

  it("queues one job when many callers ask at the same time", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        enqueueRun({ userId: DEMO_USER_ID, taskId: TASK_ID }),
      ),
    );

    const rows = await db
      .select()
      .from(runJobs)
      .where(eq(runJobs.taskId, TASK_ID));
    expect(rows).toHaveLength(1);

    const ids = new Set(results.map((result) => result.jobId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(rows[0].id);
  });

  it("rejects a checkin for a user that does not exist", async () => {
    await expect(
      db.insert(checkins).values({
        id: "chk_orphan",
        userId: "usr_missing",
        date: "2026-01-01",
        energy: 3,
        mood: 3,
        completed: [],
      }),
    ).rejects.toThrow();
  });

  it("indexes runs by task and creation time", async () => {
    const rows = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
      where schemaname = 'public'
        and tablename = 'runs'
        and indexname = 'runs_task_created_idx'
    `);
    expect(rows).toHaveLength(1);
  });
});
