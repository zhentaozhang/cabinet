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

import { pathToFileURL } from "node:url";
import { runTask } from "@/server/services/commands/tasks/run";
import {
  claimRunJob,
  finishRunJob,
  type ClaimedJob,
} from "@/server/services/commands/tasks/jobs";
import { recoverStaleRuns } from "@/server/services/commands/tasks/recovery";
import { ConflictError, PolicyDenied } from "@/lib/domain/errors";
import { installOtlpExporterIfConfigured } from "@/lib/observability/otlp";

// No Next runtime here, so nothing calls `instrumentation.ts` for us.
installOtlpExporterIfConfigured();

const once = process.argv.includes("--once");
const intervalMs = positiveInt(process.env.RUN_WORKER_INTERVAL_MS, 3_000);

/** First retry delay after a failed pass. */
export const MIN_BACKOFF_MS = 1_000;
/** Ceiling for the exponential retry delay. */
export const MAX_BACKOFF_MS = 30_000;

/**
 * Delay before the next pass: `1s, 2s, 4s … capped at 30s`, and back to 1s as
 * soon as a pass succeeds. A transient pool blip must cost one slow tick, not
 * a permanently stopped worker, and a long outage must not overflow into an
 * unbounded sleep.
 */
export function nextBackoff(prevMs: number, ok: boolean): number {
  if (ok) return MIN_BACKOFF_MS;
  const prev = Number.isFinite(prevMs) && prevMs > 0 ? prevMs : 0;
  return Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, prev * 2));
}

type PassResult = {
  recovered: number;
  executed: number;
  blocked: number;
  failed: number;
  idle: boolean;
};

/**
 * A write-back that matched no row means this worker no longer holds the
 * lease: the lease expired and another worker (or the recovery pass) took the
 * job over. Reporting "executed" there would claim an outcome nobody wrote
 * down, so the pass counts it as failed and says why.
 */
function logLostLease(job: ClaimedJob, detail: string): void {
  console.error(
    JSON.stringify({
      at: new Date().toISOString(),
      event: "lost-lease",
      jobId: job.id,
      taskId: job.taskId,
      attempts: job.attempts,
      detail,
    }),
  );
}

export async function execute(
  job: ClaimedJob,
): Promise<"executed" | "blocked" | "failed"> {
  try {
    const result = await runTask(job.taskId, job.userId);
    const runId = "runId" in result ? result.runId : null;
    const finished = await finishRunJob({
      jobId: job.id,
      claimToken: job.claimToken,
      status: "succeeded",
      runId: runId ?? null,
    });
    if (!finished.updated) {
      logLostLease(job, "success could not be written back");
      return "failed";
    }
    return "executed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const blocked = error instanceof PolicyDenied || error instanceof ConflictError;
    const finished = await finishRunJob({
      jobId: job.id,
      claimToken: job.claimToken,
      status: blocked ? "blocked" : "failed",
      error: message,
    });
    if (!finished.updated) {
      logLostLease(job, message);
    }
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

/**
 * One worker lifetime.
 *
 * A pass may fail for reasons that say nothing about this process — a dropped
 * pool connection, an advisory-lock timeout, a restarted database. Exiting on
 * the first one turns a hiccup into a permanently stopped queue drainer, so
 * every failure is logged and retried with exponential backoff; only `--once`
 * leaves the loop, and only after a pass completed.
 */
async function main(): Promise<void> {
  let backoffMs = 0;
  for (;;) {
    let ok = true;
    try {
      const result = await pass();
      if (result.recovered || !result.idle) {
        console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
      }
      if (once) {
        console.log(
          JSON.stringify({ at: new Date().toISOString(), done: true, ...result }),
        );
        // The pool keeps the event loop alive; every write is already committed.
        process.exit(0);
      }
    } catch (error) {
      ok = false;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          at: new Date().toISOString(),
          event: "pass-failed",
          error: message,
          retryInMs: nextBackoff(backoffMs, false),
        }),
      );
    }

    const delay = ok ? intervalMs : nextBackoff(backoffMs, false);
    backoffMs = nextBackoff(backoffMs, ok);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? "");
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

/** Importing this module (tests, tooling) must not start the loop. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  // main() never rejects; an unhandled rejection here would mean the loop
  // itself is broken, and the rejection is the only signal worth keeping.
  void main();
}
