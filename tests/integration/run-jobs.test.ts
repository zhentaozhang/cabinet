import { DEMO_USER_ID } from "@/lib/demo";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agentBudgetReservations,
  approvals,
  auditEvents,
  runJobs,
  runs,
  steps,
  tasks,
} from "@/lib/db/schema";
import {
  claimRunJob,
  enqueueRun,
  failExhaustedJobs,
  finishRunJob,
  MAX_CLAIM_ATTEMPTS,
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

  it("takes over a job whose lease ran out while this process was alive", async () => {
    await enqueueRun({ userId: DEMO_USER_ID, taskId: TASK_ID });
    const first = await claimRunJob({ leaseMs: 500 });
    expect(first).not.toBeNull();

    // Let the lease expire in real time. A claim predicate that snapshots
    // `new Date()` at module load compares against an instant from before this
    // claim, so it could never see this lease run out — and a worker that died
    // would leave the job in `running` until the next restart.
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const second = await claimRunJob();
    expect(second?.id).toBe(first!.id);
    expect(second?.claimToken).not.toBe(first!.claimToken);
    expect(second?.attempts).toBe(first!.attempts + 1);
  });

  it("reclaims a row whose lease is already in the past", async () => {
    await db.insert(runJobs).values({
      id: "job_orphan",
      userId: DEMO_USER_ID,
      taskId: TASK_ID,
      status: "running",
      attempts: 1,
      claimToken: "token_from_dead_worker",
      leaseUntil: new Date(Date.now() - 5_000),
      startedAt: new Date(Date.now() - 15 * 60 * 1000),
    });

    // No `now` argument: picking a job may not depend on the caller's clock.
    const claimed = await claimRunJob();
    expect(claimed?.id).toBe("job_orphan");
    expect(claimed?.attempts).toBe(2);
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

describe("attempt budget", () => {
  it("stops offering a job that spent every attempt", async () => {
    await db.insert(runJobs).values({
      id: "job_poison",
      userId: DEMO_USER_ID,
      taskId: TASK_ID,
      status: "queued",
      attempts: MAX_CLAIM_ATTEMPTS,
    });

    expect(await claimRunJob()).toBeNull();

    // Claiming alone would leave it queued forever with nobody watching.
    expect(await failExhaustedJobs()).toEqual({ failed: 1 });

    const [row] = await db
      .select()
      .from(runJobs)
      .where(eq(runJobs.id, "job_poison"));
    expect(row.status).toBe("failed");
    expect(row.finishedAt).not.toBeNull();
    expect(row.lastError).toContain("最大尝试次数");
    expect(row.lastError).toContain(String(MAX_CLAIM_ATTEMPTS));
  });

  it("leaves a live holder alone and fails the job once its lease lapses", async () => {
    await db.insert(runJobs).values({
      id: "job_last_attempt",
      userId: DEMO_USER_ID,
      taskId: TASK_ID,
      status: "queued",
      attempts: MAX_CLAIM_ATTEMPTS - 1,
    });

    const claimed = await claimRunJob();
    expect(claimed?.attempts).toBe(MAX_CLAIM_ATTEMPTS);

    // Inside its lease the worker still owns the row and decides the outcome.
    expect(await failExhaustedJobs()).toEqual({ failed: 0 });

    await db
      .update(runJobs)
      .set({ leaseUntil: new Date(Date.now() - 1_000) })
      .where(eq(runJobs.id, "job_last_attempt"));

    expect(await failExhaustedJobs()).toEqual({ failed: 1 });
    expect(await claimRunJob()).toBeNull();

    const [row] = await db
      .select()
      .from(runJobs)
      .where(eq(runJobs.id, "job_last_attempt"));
    expect(row.status).toBe("failed");
    expect(row.claimToken).toBeNull();
    expect(row.leaseUntil).toBeNull();
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

  it("reopens the approval the dead run consumed so the retry is not locked out", async () => {
    // The user approved this task, and the run that spent the approval died.
    // After the rewind the task is `planned` — RUNNABLE — so the button is
    // enabled; if the approval stayed consumed, every click would fail with
    // "Approval has already been consumed."
    await abandonedRun({ contacted: true });
    await db.insert(approvals).values({
      id: "apv_recovery",
      userId: DEMO_USER_ID,
      taskId: TASK_ID,
      action: "run",
      payload: { reason: "超阈值" },
      status: "approved",
      consumedAt: new Date(Date.now() - 120_000),
    });
    await db.insert(tasks).values({
      id: "tsk_untouched",
      userId: DEMO_USER_ID,
      title: "无关任务",
      description: "与恢复流程无关的任务。",
      assigneeId: "ag_coach",
      status: "planned",
      acceptanceCriteria: "产物存在。",
      estimateMin: 10,
      actionType: "internal",
      resource: "task",
    });
    await db.insert(approvals).values({
      id: "apv_other_task",
      userId: DEMO_USER_ID,
      taskId: "tsk_untouched",
      action: "run",
      payload: { reason: "另一个任务" },
      status: "approved",
      consumedAt: new Date(Date.now() - 120_000),
    });

    const result = await recoverStaleRuns({ olderThanMs: 60_000 });
    expect(result.recovered).toBe(1);

    const [reopened] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, "apv_recovery"));
    expect(reopened.consumedAt).toBeNull();

    // Only the recovered task's approval is reopened; another task's spent
    // approval is still a historical fact.
    const [untouched] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, "apv_other_task"));
    expect(untouched.consumedAt).not.toBeNull();

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "run.recovered"));
    expect((event.after as Record<string, unknown>).approvalReopened).toBe(true);
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
