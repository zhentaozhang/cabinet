import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The worker script is a long-lived process, so every dependency that touches
 * the database is stubbed. Importing the module must not start the loop: the
 * entry point only runs when the script itself is the process entry.
 */
const stubs = vi.hoisted(() => ({
  runTask: vi.fn(),
  claimRunJob: vi.fn(),
  finishRunJob: vi.fn(),
  recoverStaleRuns: vi.fn(),
}));

vi.mock("@/server/services/commands/tasks/run", () => ({
  runTask: stubs.runTask,
}));

vi.mock("@/server/services/commands/tasks/jobs", () => ({
  claimRunJob: stubs.claimRunJob,
  finishRunJob: stubs.finishRunJob,
}));

vi.mock("@/server/services/commands/tasks/recovery", () => ({
  recoverStaleRuns: stubs.recoverStaleRuns,
}));

import { ConflictError, PolicyDenied } from "@/lib/domain/errors";
import type { ClaimedJob } from "@/server/services/commands/tasks/jobs";
import {
  MAX_BACKOFF_MS,
  MIN_BACKOFF_MS,
  execute,
  nextBackoff,
} from "../../scripts/run-worker";

const JOB: ClaimedJob = {
  id: "job_1",
  userId: "usr_zhen",
  taskId: "tsk_read",
  attempts: 1,
  claimToken: "claim_1",
};

function consoleErrorText(): string {
  const spy = vi.mocked(console.error);
  return spy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

beforeEach(() => {
  stubs.runTask.mockReset();
  stubs.claimRunJob.mockReset();
  stubs.finishRunJob.mockReset();
  stubs.recoverStaleRuns.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("worker backoff", () => {
  it("starts at one second and doubles up to a thirty second ceiling", () => {
    expect(MIN_BACKOFF_MS).toBe(1_000);
    expect(MAX_BACKOFF_MS).toBe(30_000);

    let delay = nextBackoff(0, false);
    expect(delay).toBe(1_000);
    delay = nextBackoff(delay, false);
    expect(delay).toBe(2_000);
    delay = nextBackoff(delay, false);
    expect(delay).toBe(4_000);
    delay = nextBackoff(delay, false);
    expect(delay).toBe(8_000);
    delay = nextBackoff(delay, false);
    expect(delay).toBe(16_000);
    delay = nextBackoff(delay, false);
    expect(delay).toBe(MAX_BACKOFF_MS);
    // A long outage must not overflow into an unbounded sleep.
    expect(nextBackoff(MAX_BACKOFF_MS, false)).toBe(MAX_BACKOFF_MS);
  });

  it("resets to one second after a successful pass", () => {
    expect(nextBackoff(16_000, true)).toBe(MIN_BACKOFF_MS);
    // The reset is what a subsequent failure must observe.
    expect(nextBackoff(nextBackoff(16_000, true), false)).toBe(2_000);
  });

  it("treats a missing or nonsensical previous delay as the first failure", () => {
    expect(nextBackoff(Number.NaN, false)).toBe(MIN_BACKOFF_MS);
    expect(nextBackoff(-5, false)).toBe(MIN_BACKOFF_MS);
    expect(nextBackoff(0, false)).toBe(MIN_BACKOFF_MS);
  });
});

describe("worker execute outcome", () => {
  it("reports executed only when the result was actually written back", async () => {
    stubs.runTask.mockResolvedValue({ runId: "run_1" });
    stubs.finishRunJob.mockResolvedValue({ updated: true });

    await expect(execute(JOB)).resolves.toBe("executed");
    expect(stubs.finishRunJob).toHaveBeenCalledWith({
      jobId: JOB.id,
      claimToken: JOB.claimToken,
      status: "succeeded",
      runId: "run_1",
    });
  });

  it("reports failed and logs lost-lease when the write-back matched no row", async () => {
    stubs.runTask.mockResolvedValue({ runId: "run_1" });
    // Zero rows updated: the lease was reclaimed (or taken over) mid-run.
    stubs.finishRunJob.mockResolvedValue({ updated: false });

    await expect(execute(JOB)).resolves.toBe("failed");
    expect(consoleErrorText()).toContain("lost-lease");
  });

  it("keeps a policy denial blocked and records the reason", async () => {
    stubs.runTask.mockRejectedValue(new PolicyDenied("外部动作需批准"));
    stubs.finishRunJob.mockResolvedValue({ updated: true });

    await expect(execute(JOB)).resolves.toBe("blocked");
    expect(stubs.finishRunJob).toHaveBeenCalledWith({
      jobId: JOB.id,
      claimToken: JOB.claimToken,
      status: "blocked",
      error: "外部动作需批准",
    });
  });

  it("reports a state conflict as blocked", async () => {
    stubs.runTask.mockRejectedValue(new ConflictError("Task state changed"));
    stubs.finishRunJob.mockResolvedValue({ updated: true });

    await expect(execute(JOB)).resolves.toBe("blocked");
  });

  it("reports an unexpected error as failed", async () => {
    stubs.runTask.mockRejectedValue(new Error("provider exploded"));
    stubs.finishRunJob.mockResolvedValue({ updated: true });

    await expect(execute(JOB)).resolves.toBe("failed");
    expect(stubs.finishRunJob).toHaveBeenCalledWith({
      jobId: JOB.id,
      claimToken: JOB.claimToken,
      status: "failed",
      error: "provider exploded",
    });
  });

  it("does not claim an error was recorded when the lease was already lost", async () => {
    stubs.runTask.mockRejectedValue(new Error("provider exploded"));
    stubs.finishRunJob.mockResolvedValue({ updated: false });

    await expect(execute(JOB)).resolves.toBe("failed");
    expect(consoleErrorText()).toContain("lost-lease");
  });
});
