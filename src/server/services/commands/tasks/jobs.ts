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

/**
 * Queue a run. Idempotent per task: asking twice while one is still queued
 * returns the same job rather than starting two runs of the same task.
 */
export async function enqueueRun(input: {
  userId: string;
  taskId: string;
  requestedBy?: string;
}): Promise<{ jobId: string; existing: boolean }> {
  const [pending] = await db
    .select({ id: runJobs.id })
    .from(runJobs)
    .where(
      and(
        eq(runJobs.userId, input.userId),
        eq(runJobs.taskId, input.taskId),
        or(eq(runJobs.status, "queued"), eq(runJobs.status, "running")),
      ),
    )
    .orderBy(desc(runJobs.createdAt))
    .limit(1);
  if (pending) return { jobId: pending.id, existing: true };

  const jobId = newId("job");
  await db
    .insert(runJobs)
    .values({
      id: jobId,
      userId: input.userId,
      taskId: input.taskId,
      status: "queued",
      requestedBy: input.requestedBy ?? "user",
    })
    .onConflictDoNothing();
  return { jobId, existing: false };
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
