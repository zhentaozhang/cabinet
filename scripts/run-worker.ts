/**
 * Durable run worker.
 *
 * One pass = recover abandoned runs, then claim and execute queued jobs until
 * the queue is empty. Run it from cron (`--once`) or keep it as a long-lived
 * process; either way the lease in the database is what decides who owns a run,
 * so two workers never execute the same job.
 */
// A CLI process has no Next runtime: load the same env the app would see.
import "../src/lib/env";

import { runTask } from "@/server/services/commands/tasks/run";
import {
  claimRunJob,
  finishRunJob,
  type ClaimedJob,
} from "@/server/services/commands/tasks/jobs";
import { recoverStaleRuns } from "@/server/services/commands/tasks/recovery";
import { ConflictError, PolicyDenied } from "@/lib/domain/errors";

const once = process.argv.includes("--once");
const intervalMs = positiveInt(process.env.RUN_WORKER_INTERVAL_MS, 3_000);

type PassResult = {
  recovered: number;
  executed: number;
  blocked: number;
  failed: number;
  idle: boolean;
};

async function execute(job: ClaimedJob): Promise<"executed" | "blocked" | "failed"> {
  try {
    const result = await runTask(job.taskId, job.userId);
    const runId = "runId" in result ? result.runId : null;
    await finishRunJob({
      jobId: job.id,
      claimToken: job.claimToken,
      status: "succeeded",
      runId: runId ?? null,
    });
    return "executed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const blocked = error instanceof PolicyDenied || error instanceof ConflictError;
    await finishRunJob({
      jobId: job.id,
      claimToken: job.claimToken,
      status: blocked ? "blocked" : "failed",
      error: message,
    });
    return blocked ? "blocked" : "failed";
  }
}

async function pass(): Promise<PassResult> {
  const recovery = await recoverStaleRuns();
  const tally: PassResult = {
    recovered: recovery.recovered,
    executed: 0,
    blocked: 0,
    failed: 0,
    idle: true,
  };

  for (;;) {
    const job = await claimRunJob();
    if (!job) break;
    tally.idle = false;
    const outcome = await execute(job);
    if (outcome === "executed") tally.executed += 1;
    else if (outcome === "blocked") tally.blocked += 1;
    else tally.failed += 1;
    if (once) break;
  }

  return tally;
}

async function main() {
  for (;;) {
    const result = await pass();
    if (result.recovered || !result.idle) {
      console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
    }
    if (once) {
      console.log(JSON.stringify({ at: new Date().toISOString(), done: true, ...result }));
      // The pool keeps the event loop alive; every write is already committed.
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? "");
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

main().catch((error) => {
  console.error("[run-worker] failed", error);
  process.exit(1);
});
