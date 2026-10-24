import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { runJobs } from "@/lib/db/schema";
import { newId } from "@/lib/ids";

export type RunJobStatus = "queued" | "running" | "succeeded" | "blocked" | "failed";

export type ClaimedJob = {
  id: string;
  userId: string;
  taskId: string;
  attempts: number;
  claimToken: string;
};

/** How long a claimed job may run before another worker may take it over. */
export const DEFAULT_LEASE_MS = 10 * 60 * 1000;

/** Lease in ms, overridable so a slow deployment can widen it without a build. */
export function leaseMs(): number {
  const minutes = Number(process.env.RUN_LEASE_MINUTES ?? "");
  return Number.isFinite(minutes) && minutes > 0
    ? Math.trunc(minutes * 60_000)
    : DEFAULT_LEASE_MS;
}

function leaseMsFromEnv(): number {
  const minutes = Number(process.env.RUN_LEASE_MINUTES ?? "");
  return Number.isFinite(minutes) && minutes > 0
    ? Math.trunc(minutes * 60_000)
    : DEFAULT_LEASE_MS;
}

const CLAIMABLE = or(
  eq(runJobs.status, "queued"),
  and(eq(runJobs.status, "running"), lte(runJobs.leaseUntil, new Date())),
);

/** Statuses a job only leaves; a live job blocks a second one for its task. */
const ACTIVE_JOB = or(eq(runJobs.status, "queued"), eq(runJobs.status, "running"));

/**
 * The predicate of `run_jobs_active_task_idx`, repeated verbatim.
 *
 * Postgres only infers a partial index in `ON CONFLICT` when the conflict
 * target names the same predicate, so the two definitions must stay identical.
 */
const ACTIVE_JOB_PREDICATE = sql`${runJobs.status} in ('queued', 'running')`;

/** How many times to re-read the winner before giving up on a conflict. */
const ENQUEUE_ATTEMPTS = 5;

async function liveJobId(
  userId: string,
  taskId: string,
): Promise<string | null> {
  const [pending] = await db
    .select({ id: runJobs.id })
    .from(runJobs)
    .where(
      and(
        eq(runJobs.userId, userId),
        eq(runJobs.taskId, taskId),
        ACTIVE_JOB,
      ),
    )
    .orderBy(desc(runJobs.createdAt))
    .limit(1);
  return pending?.id ?? null;
}

/**
 * Queue a run. Idempotent per task: asking twice while one is still queued
 * returns the same job rather than starting two runs of the same task.
 *
 * The read above is not a lock, so two callers can both find no live job. The
 * insert then loses to `run_jobs_active_task_idx` instead of creating a second
 * job, and the loser adopts the winner's row — reporting the id it tried to
 * insert would hand out a job id that does not exist.
 */
export async function enqueueRun(input: {
  userId: string;
  taskId: string;
  requestedBy?: string;
}): Promise<{ jobId: string; existing: boolean }> {
  const pending = await liveJobId(input.userId, input.taskId);
  if (pending) return { jobId: pending, existing: true };

  for (let attempt = 0; attempt < ENQUEUE_ATTEMPTS; attempt += 1) {
    const [inserted] = await db
      .insert(runJobs)
      .values({
        id: newId("job"),
        userId: input.userId,
        taskId: input.taskId,
        status: "queued",
        requestedBy: input.requestedBy ?? "user",
      })
      .onConflictDoNothing({
        target: runJobs.taskId,
        where: ACTIVE_JOB_PREDICATE,
      })
      .returning({ id: runJobs.id });
    if (inserted) return { jobId: inserted.id, existing: false };

    // The conflict means someone else queued this task first — unless that job
    // finished in the meantime, in which case the slot is free again.
    const winner = await liveJobId(input.userId, input.taskId);
    if (winner) return { jobId: winner, existing: true };
  }

  throw new Error(
    `Could not queue task ${input.taskId}: the active job kept changing.`,
  );
}

/**
 * Claim the oldest runnable job with a lease.
 *
 * `skipLocked` means concurrent workers never wait on each other: each one takes
 * a different row, and a worker that died simply leaves a lease that expires.
 */
export async function claimRunJob(
  options: { leaseMs?: number; now?: Date } = {},
): Promise<ClaimedJob | null> {
  const now = options.now ?? new Date();
  const lease = options.leaseMs ?? leaseMsFromEnv();

  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: runJobs.id })
      .from(runJobs)
      .where(CLAIMABLE)
      .orderBy(runJobs.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return null;

    const claimToken = randomUUID();
    const [claimed] = await tx
      .update(runJobs)
      .set({
        status: "running",
        claimToken,
        leaseUntil: new Date(now.getTime() + lease),
        startedAt: sql`coalesce(${runJobs.startedAt}, ${now.toISOString()}::timestamptz)`,
        attempts: sql`${runJobs.attempts} + 1`,
      })
      .where(and(eq(runJobs.id, candidate.id), CLAIMABLE))
      .returning({
        id: runJobs.id,
        userId: runJobs.userId,
        taskId: runJobs.taskId,
        attempts: runJobs.attempts,
      });
    if (!claimed) return null;
    return { ...claimed, claimToken };
  });
}

/**
 * Write a result back only if this worker still holds the lease.
 *
 * A worker whose lease expired mid-run must not overwrite the newer holder's
 * result — it lost the row, and pretending otherwise would report an outcome
 * nobody verified.
 */
export async function finishRunJob(input: {
  jobId: string;
  claimToken: string;
  status: Exclude<RunJobStatus, "queued" | "running">;
  runId?: string | null;
  error?: string | null;
}): Promise<{ updated: boolean }> {
  const [updated] = await db
    .update(runJobs)
    .set({
      status: input.status,
      runId: input.runId ?? null,
      lastError: input.error ?? null,
      claimToken: null,
      leaseUntil: null,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(runJobs.id, input.jobId),
        eq(runJobs.claimToken, input.claimToken),
        eq(runJobs.status, "running"),
      ),
    )
    .returning({ id: runJobs.id });
  return { updated: Boolean(updated) };
}

/** Queue depth, for the settings/health view. */
export async function countQueuedJobs(userId?: string): Promise<number> {
  const where = userId
    ? and(eq(runJobs.userId, userId), eq(runJobs.status, "queued"))
    : eq(runJobs.status, "queued");
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(runJobs)
    .where(and(where, isNull(runJobs.finishedAt)));
  return Number(row?.n ?? 0);
}
