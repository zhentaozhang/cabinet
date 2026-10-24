/**
 * Cancelling stops work; it does not erase it.
 *
 * These tests exist because "cancel" is the easiest place to quietly turn into
 * "delete": a cancelled task that dropped its artifacts would make a bad run
 * disappear from the audit trail. The last two cases are the other half of the
 * same promise — once a running task is cancellable, cancelling must actually
 * stop the run beneath it instead of only repainting the task.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

/**
 * The provider is the one place a test can hold a run open: runTask commits the
 * claim (task → running, run row, budget hold) before it asks for the draft, so
 * gating this promise is exactly "the run is in flight".
 */
const provider = vi.hoisted(() => ({
  impl: null as null | (() => Promise<unknown>),
}));

vi.mock("@/lib/llm", () => ({
  generateArtifact: () => provider.impl!(),
}));

import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agentBudgetReservations,
  artifacts,
  auditEvents,
  evidence,
  runJobs,
  runs,
  tasks,
} from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { ConflictError } from "@/lib/domain/errors";
import { cancelTask } from "@/server/services/commands/tasks/cancel";
import { markTaskDone } from "@/server/services/commands/tasks/done";
import { reserveBudget } from "@/server/services/commands/tasks/execution";
import { runTask } from "@/server/services/commands/tasks/run";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
  provider.impl = null;
});

async function readTask(id: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  return row;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Waits for the claim to commit: a running run with its hold attached. */
async function waitForRunningRun(taskId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [run] = await db.select().from(runs).where(eq(runs.taskId, taskId));
    if (run?.status === "running") {
      const [hold] = await db
        .select()
        .from(agentBudgetReservations)
        .where(eq(agentBudgetReservations.runId, run.id));
      if (hold) return run;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error("run never reached the provider");
}

describe("cancelling a task", () => {
  it("moves a planned task to cancelled and records why", async () => {
    await cancelTask("tsk_read", DEMO_USER_ID, "这周先不做");

    const task = await readTask("tsk_read");
    expect(task.status).toBe("cancelled");

    const audit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.target, "tsk_read"));
    const cancel = audit.find((row) => row.action === "task.cancel");
    expect(cancel).toBeDefined();
    expect((cancel?.after as { reason?: string } | null)?.reason).toBe("这周先不做");
  });

  it("keeps the artifacts and evidence that already exist", async () => {
    // Money and work already spent must survive the cancellation: this is the
    // whole difference between "cancel" and "delete".
    await db
      .update(tasks)
      .set({ status: "planned" })
      .where(eq(tasks.id, "tsk_research"));
    const [run] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.taskId, "tsk_research"))
      .limit(1);
    await db.insert(artifacts).values({
      id: "art_cancel_test",
      taskId: "tsk_research",
      runId: run?.id ?? null,
      type: "markdown",
      title: "取消前的产物",
      content: "保留我",
    });
    await db.insert(evidence).values({
      id: "evd_cancel_test",
      userId: DEMO_USER_ID,
      taskId: "tsk_research",
      runId: run?.id ?? null,
      kind: "web_page",
      url: "https://example.org/keep",
      title: "保留我的来源",
      quote: "取消不该删掉证据。",
      provider: "brave",
      contentHash: "a".repeat(64),
      retrievedAt: new Date(),
    });

    await cancelTask("tsk_research", DEMO_USER_ID);

    expect((await readTask("tsk_research")).status).toBe("cancelled");
    const keptArtifacts = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, "art_cancel_test"));
    const keptEvidence = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, "evd_cancel_test"));
    expect(keptArtifacts).toHaveLength(1);
    expect(keptEvidence).toHaveLength(1);
  });

  it("refuses to cancel a finished record", async () => {
    // accepted → done is the terminal path; nothing here may be undone.
    const [accepted] = await db
      .update(tasks)
      .set({ status: "accepted" })
      .where(eq(tasks.id, "tsk_read"))
      .returning();
    await markTaskDone(accepted.id, DEMO_USER_ID);

    await expect(cancelTask("tsk_read", DEMO_USER_ID)).rejects.toThrow(/已完成/);
    expect((await readTask("tsk_read")).status).toBe("done");
  });

  it("cancels a run in flight, failing the run, its job and its hold", async () => {
    // A running task used to be uncancellable, which left a task whose worker
    // died (inline mode, killed process) running forever with the week's budget
    // still reserved. Cancelling now has to close all three rows, not just the
    // task, or the status is a promise nobody kept.
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, "tsk_read"));

    const hold = await reserveBudget({
      userId: DEMO_USER_ID,
      agentId: "ag_coach",
      taskId: "tsk_read",
      timezone: "Asia/Shanghai",
      amountCents: 50,
    });
    if (!hold.allowed) throw new Error(hold.reason);

    await db.insert(runs).values({
      id: "run_cancelled_midway",
      taskId: "tsk_read",
      agentId: "ag_coach",
      status: "running",
      mode: "demo",
      startedAt: new Date(),
    });
    await db
      .update(agentBudgetReservations)
      .set({ runId: "run_cancelled_midway" })
      .where(eq(agentBudgetReservations.id, hold.reservationId));
    await db.insert(runJobs).values({
      id: "rjb_cancelled_midway",
      userId: DEMO_USER_ID,
      taskId: "tsk_read",
      status: "running",
      attempts: 1,
      claimToken: "claim_cancelled_midway",
      leaseUntil: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });

    await cancelTask("tsk_read", DEMO_USER_ID, "别跑了");

    expect((await readTask("tsk_read")).status).toBe("cancelled");

    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, "run_cancelled_midway"));
    expect(run.status).toBe("failed");
    expect(run.endedAt).not.toBeNull();
    expect(run.error).toContain("任务被取消");

    const [job] = await db
      .select()
      .from(runJobs)
      .where(eq(runJobs.id, "rjb_cancelled_midway"));
    expect(job.status).toBe("failed");
    expect(job.finishedAt).not.toBeNull();
    expect(job.lastError).toContain("任务被取消");
    // The claim token is what finishRunJob matches on, so clearing it is what
    // refuses a worker that comes back later.
    expect(job.claimToken).toBeNull();
    expect(job.leaseUntil).toBeNull();

    const [reservation] = await db
      .select()
      .from(agentBudgetReservations)
      .where(eq(agentBudgetReservations.id, hold.reservationId));
    expect(reservation.state).toBe("unknown_charged");
    expect(reservation.settledCents).toBe(0);

    const [period] = await db
      .select()
      .from(agentBudgetPeriods)
      .where(eq(agentBudgetPeriods.id, hold.periodId));
    // The hold is gone, but the money is not refunded: the run may already have
    // reached a provider, and a free mid-run cancel would be a discount.
    expect(period.reservedCents).toBe(0);
    expect(period.unknownCents).toBe(50);

    const audit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.target, "tsk_read"));
    const cancel = audit.find((row) => row.action === "task.cancel");
    expect(cancel?.after).toMatchObject({ cancelledRuns: 1, cancelledJobs: 1 });
  });

  it("does not let a run that finishes after the cancel revive the task", async () => {
    // The dangerous case: the run's success transaction writes the task back to
    // submitted. If that write were unconditional, cancelling mid-run would be
    // undone a second later and the task would look like it completed.
    const gate = deferred<unknown>();
    provider.impl = () => gate.promise;

    const pending = runTask("tsk_read", DEMO_USER_ID);
    const live = await waitForRunningRun("tsk_read");

    await cancelTask("tsk_read", DEMO_USER_ID, "不做了");
    expect((await readTask("tsk_read")).status).toBe("cancelled");

    // The provider answers after the cancel committed — the worst possible
    // ordering for a guarded write-back.
    gate.resolve({
      status: "success",
      provider: "openai",
      model: "gpt-4.1-mini",
      attemptId: "att_cancelled_midway",
      costSource: "actual",
      draft: { title: "取消之后才回来的产物", content: "不该写进去", tokensIn: 10, tokensOut: 10 },
    });

    await expect(pending).rejects.toBeInstanceOf(ConflictError);

    expect((await readTask("tsk_read")).status).toBe("cancelled");
    const [run] = await db.select().from(runs).where(eq(runs.id, live.id));
    expect(run.status).toBe("failed");

    // The artifact insert sits in the same transaction as the task write, so a
    // refused write-back must leave nothing behind.
    const lateArtifacts = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, live.id));
    expect(lateArtifacts).toHaveLength(0);

    const submitted = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "task.submit"), eq(auditEvents.target, "tsk_read")),
      );
    expect(submitted).toHaveLength(0);

    // The hold was already settled as unknown by the cancel; the failing run
    // must not charge it a second time.
    const [reservation] = await db
      .select()
      .from(agentBudgetReservations)
      .where(eq(agentBudgetReservations.runId, live.id));
    expect(reservation.state).toBe("unknown_charged");
  });

  it("cannot cancel someone else's task", async () => {
    await expect(cancelTask("tsk_read", "usr_other")).rejects.toThrow(/not found/i);
  });
});
