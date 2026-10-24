import { DEMO_USER_ID } from "@/lib/demo";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agentBudgetReservations,
  runJobs,
  runs,
  steps,
  tasks,
} from "@/lib/db/schema";
import {
  claimRunJob,
  enqueueRun,
  finishRunJob,
} from "@/server/services/commands/tasks/jobs";
import { recoverStaleRuns } from "@/server/services/commands/tasks/recovery";
import { reserveBudget } from "@/server/services/commands/tasks/execution";
import { resetDb } from "../helpers/db";

const TASK_ID = "tsk_job";
const RUN_ID = "run_job";

beforeEach(async () => {
  await resetDb();
  await db.insert(tasks).values({
    id: TASK_ID,
    userId: DEMO_USER_ID,
    title: "排队执行",
    description: "由 worker 认领的任务。",
    assigneeId: "ag_coach",
    auditorId: "ag_auditor",
    status: "running",
    acceptanceCriteria: "产物存在。",
    estimateMin: 10,
    actionType: "internal",
    resource: "task",
  });
});

describe("run jobs", () => {
  it("queues a task once, however often it is asked", async () => {
    const first = await enqueueRun({ userId: DEMO_USER_ID, taskId: TASK_ID });
    const second = await enqueueRun({ userId: DEMO_USER_ID, taskId: TASK_ID });

    expect(first.existing).toBe(false);
    expect(second.jobId).toBe(first.jobId);
    expect(second.existing).toBe(true);
    const rows = await db.select().from(runJobs).where(eq(runJobs.taskId, TASK_ID));
    expect(rows).toHaveLength(1);
  });

  it("queues a fresh job once the previous one finished", async () => {
    const first = await enqueueRun({ userId: DEMO_USER_ID, taskId: TASK_ID });
    await db
      .update(runJobs)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(runJobs.id, first.jobId));

    const second = await enqueueRun({ userId: DEMO_USER_ID, taskId: TASK_ID });

    expect(second.existing).toBe(false);
    expect(second.jobId).not.toBe(first.jobId);
    const rows = await db
      .select()
      .from(runJobs)
      .where(eq(runJobs.taskId, TASK_ID));
    expect(rows).toHaveLength(2);
  });

  it("lets exactly one worker hold a job", async () => {
    await enqueueRun({ userId: DEMO_USER_ID, taskId: TASK_ID });

    const claimed = await claimRunJob();
    expect(claimed?.taskId).toBe(TASK_ID);
    expect(await claimRunJob()).toBeNull();
  });

  it("re-offers a job whose lease expired", async () => {
    await enqueueRun({ userId: DEMO_USER_ID, taskId: TASK_ID });
    const first = await claimRunJob({ leaseMs: 1, now: new Date(Date.now() - 60_000) });

    const second = await claimRunJob();
    expect(second?.id).toBe(first?.id);
    expect(second?.claimToken).not.toBe(first?.claimToken);
  });

  it("refuses a write-back from a worker that no longer holds the lease", async () => {
    await enqueueRun({ userId: DEMO_USER_ID, taskId: TASK_ID });
    const first = await claimRunJob({ leaseMs: 1, now: new Date(Date.now() - 60_000) });
    const second = await claimRunJob();

    const lost = await finishRunJob({
      jobId: first!.id,
      claimToken: first!.claimToken,
      status: "succeeded",
      runId: "run_ghost",
    });
    expect(lost.updated).toBe(false);

    const won = await finishRunJob({
      jobId: second!.id,
      claimToken: second!.claimToken,
      status: "succeeded",
      runId: "run_real",
    });
    expect(won.updated).toBe(true);
  });
});

describe("stale run recovery", () => {
  async function abandonedRun(options: { contacted: boolean }) {
    const hold = await reserveBudget({
      userId: DEMO_USER_ID,
      agentId: "ag_coach",
      taskId: TASK_ID,
      timezone: "Asia/Shanghai",
      amountCents: 50,
    });
    expect(hold.allowed).toBe(true);
    const reservationId = hold.allowed ? hold.reservationId : "";

    await db.insert(runs).values({
      id: RUN_ID,
      taskId: TASK_ID,
      agentId: "ag_coach",
      status: "running",
      mode: "live",
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await db
      .update(agentBudgetReservations)
      .set({ runId: RUN_ID })
      .where(eq(agentBudgetReservations.id, reservationId));

    if (options.contacted) {
      await db.insert(steps).values({
        id: "stp_job_1",
        runId: RUN_ID,
        idx: 1,
        type: "tool",
        tool: "web_search",
        input: { query: "x" },
        output: { status: "ok", provider: "brave", hits: 3 },
      });
    }
    return reservationId;
  }

  it("charges unknown usage when the run may have reached a provider", async () => {
    const reservationId = await abandonedRun({ contacted: true });

    const result = await recoverStaleRuns({ olderThanMs: 60_000 });
    expect(result.recovered).toBe(1);
    expect(result.unknownCents).toBe(50);

    const [run] = await db.select().from(runs).where(eq(runs.id, RUN_ID));
    expect(run.status).toBe("failed");
    const [hold] = await db
      .select()
      .from(agentBudgetReservations)
      .where(eq(agentBudgetReservations.id, reservationId));
    expect(hold.state).toBe("unknown_charged");

    const [task] = await db.select().from(tasks).where(eq(tasks.id, TASK_ID));
    expect(task.status).toBe("planned");

    const [period] = await db
      .select()
      .from(agentBudgetPeriods)
      .where(eq(agentBudgetPeriods.agentId, "ag_coach"));
    expect(period.reservedCents).toBe(0);
    expect(period.unknownCents).toBe(50);
  });

  it("releases the hold when nothing ever left the process", async () => {
    const reservationId = await abandonedRun({ contacted: false });

    const result = await recoverStaleRuns({ olderThanMs: 60_000 });
    expect(result.recovered).toBe(1);
    expect(result.unknownCents).toBe(0);

    const [hold] = await db
      .select()
      .from(agentBudgetReservations)
      .where(eq(agentBudgetReservations.id, reservationId));
    expect(hold.state).toBe("released");

    const [period] = await db
      .select()
      .from(agentBudgetPeriods)
      .where(eq(agentBudgetPeriods.agentId, "ag_coach"));
    expect(period.unknownCents).toBe(0);
    expect(period.reservedCents).toBe(0);
  });

  it("leaves a fresh run alone", async () => {
    await abandonedRun({ contacted: false });
    await db
      .update(runs)
      .set({ startedAt: new Date() })
      .where(and(eq(runs.id, RUN_ID)));

    const result = await recoverStaleRuns({ olderThanMs: 60_000 });
    expect(result.recovered).toBe(0);
    const [run] = await db.select().from(runs).where(eq(runs.id, RUN_ID));
    expect(run.status).toBe("running");
  });
});
