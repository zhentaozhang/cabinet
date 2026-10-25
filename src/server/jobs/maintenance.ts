import { and, eq, inArray, isNull, lt, lte } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agentBudgetReservations,
  approvals,
  dissents,
  idempotencyKeys,
  outbox,
  rateLimits,
} from "@/lib/db/schema";
import { evaluateDissents } from "@/server/services/commands/council/dissent";
import { expireApprovalInTx } from "@/server/services/commands/tasks/approvals";
import { settleBudget } from "@/server/services/commands/tasks/execution";
import { failExhaustedJobs } from "@/server/services/commands/tasks/jobs";
import { recoverStaleRuns } from "@/server/services/commands/tasks/recovery";

/**
 * The maintenance sweeps, and the only thing that runs them.
 *
 * Every function here is a reconciliation, not a business action: it looks for
 * rows the normal flow would have moved and did not — a run whose process died,
 * an approval nobody answered, a job that burned its attempts, a window that
 * closed a day ago. They were all written at some point and then had no caller,
 * so the state they were supposed to clean stayed exactly as it was. One tick
 * that runs them in order is the difference between "the code exists" and "the
 * code happens".
 *
 * Three rules hold for every sweep below:
 *   - idempotent: re-running it changes nothing, which is what allows a cron
 *     schedule of once a minute;
 *   - conditional: every update/delete carries the state it expects, so two
 *     ticks (or a tick racing a request) cannot both act on one row;
 *   - no parameters required: a scheduler passes nothing, so defaults must be
 *     the production-correct ones.
 */

/** Approvals older than this sweep's batch are picked up by the next one. */
const SWEEP_BATCH = 1000;

export type ApprovalSweepResult = {
  expired: number;
  tasksRewound: number;
  ids: string[];
};

/**
 * Expire pending approvals that ran out of time, and return their tasks to
 * `planned`.
 *
 * The user-facing path (`decideApproval`) only expires the approval it was
 * called with; an approval nobody clicks stayed `pending` forever and its task
 * stayed parked in `awaiting_approval`, so the queue reported work waiting on
 * a human who had already been sent a deadline that passed. The semantics are
 * the shared `expireApprovalInTx`, not a second copy of them.
 */
export async function expireStaleApprovals(
  options: { now?: Date } = {},
): Promise<ApprovalSweepResult> {
  const now = options.now ?? new Date();
  const stale = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(eq(approvals.status, "pending"), lte(approvals.expiresAt, now)),
    )
    .limit(SWEEP_BATCH);

  const ids: string[] = [];
  let tasksRewound = 0;

  for (const row of stale) {
    // One transaction per approval: a single poisonous row (a task mid-flight
    // through another transition) must not roll back the rest of the sweep.
    const outcome = await db.transaction((tx) =>
      expireApprovalInTx(tx, { approvalId: row.id, now }),
    );
    if (!outcome.expired) continue;
    ids.push(row.id);
    if (outcome.taskRewound) tasksRewound += 1;
  }

  return { expired: ids.length, tasksRewound, ids };
}

/**
 * Window rows older than this are outside every window any request can still
 * be counting against, so nothing reads them again.
 */
export const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Drop rate-limit windows that closed more than a day ago.
 *
 * Without this the table grows one row per (user, action, window) forever. The
 * counter is time-bucketed by construction — a new window inserts a new row —
 * so there is no history worth keeping here, and deleting a stale bucket cannot
 * grant a request a fresh allowance.
 */
export async function pruneRateLimits(
  options: { now?: Date; retentionMs?: number } = {},
): Promise<{ deleted: number }> {
  const now = options.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - (options.retentionMs ?? RATE_LIMIT_RETENTION_MS),
  );
  const deleted = await db
    .delete(rateLimits)
    .where(lt(rateLimits.windowStart, cutoff))
    .returning({ id: rateLimits.id });
  return { deleted: deleted.length };
}

/**
 * Drop idempotency records whose replay window has closed.
 *
 * The handler used to clean up opportunistically, and only for the same user
 * and key as the request that happened to arrive — so a key used once and never
 * again kept its row forever, including the stored response body. Expired rows
 * are already untrustworthy (`isExpired` treats them as absent), so deleting
 * them removes storage, not a guarantee.
 */
export async function pruneIdempotencyKeys(
  options: { now?: Date } = {},
): Promise<{ deleted: number }> {
  const now = options.now ?? new Date();
  const deleted = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, now))
    .returning({ id: idempotencyKeys.id });
  return { deleted: deleted.length };
}

/** Default retention for outbox rows that reached a terminal status. */
export const OUTBOX_RETENTION_DAYS = 30;

function outboxRetentionMs(): number {
  const days = Number(process.env.OUTBOX_RETENTION_DAYS ?? "");
  return Number.isFinite(days) && days > 0
    ? Math.trunc(days * 24 * 60 * 60 * 1000)
    : OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Delete delivered or deliberately-skipped notifications older than the
 * retention window.
 *
 * Only `sent` and `skipped` are terminal. `pending`/`sending` still own a claim
 * and maybe an owed mail; `failed` is the record of why an address stopped
 * working, which an operator reads after the fact. None of those are touched —
 * an archive that deletes owed mail is worse than an unbounded table.
 *
 * `createdAt` is the cutoff, not `sentAt`: a skipped row was never sent and has
 * no `sentAt`, and its dedupe key is scoped to a single day, so nothing inside
 * the retention window is still deduplicating against it.
 */
export async function archiveOldOutbox(
  options: { now?: Date; retentionMs?: number } = {},
): Promise<{ deleted: number }> {
  const now = options.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - (options.retentionMs ?? outboxRetentionMs()),
  );
  const deleted = await db
    .delete(outbox)
    .where(
      and(
        inArray(outbox.status, ["sent", "skipped"]),
        lt(outbox.createdAt, cutoff),
      ),
    )
    .returning({ id: outbox.id });
  return { deleted: deleted.length };
}

export type DissentSweepResult = {
  users: number;
  vindicated: number;
  invalidated: number;
  failed: number;
};

/**
 * Settle every dissent whose observation window has closed.
 *
 * `evaluateDissents` was only reachable from `/api/reflect`, and reflection is
 * a thing a person clicks. A dissent that nobody clicked never got judged, so
 * "the Council was wrong" stayed a permanent `pending` row and the metric it
 * promised to watch was never read. The judge itself already skips dissents
 * whose window is still open, which is what makes a per-minute sweep cheap and
 * idempotent.
 *
 * Only users that actually have a pending dissent are visited, so an idle
 * workspace costs one grouped query.
 */
export async function settleDueDissents(): Promise<DissentSweepResult> {
  const pending = await db
    .select({ userId: dissents.userId })
    .from(dissents)
    .where(eq(dissents.status, "pending"))
    .groupBy(dissents.userId);

  let vindicated = 0;
  let invalidated = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      const result = await evaluateDissents(row.userId);
      vindicated += result.vindicated;
      invalidated += result.invalidated;
    } catch {
      // One workspace's broken dissent must not stop the other workspaces from
      // being settled; the count surfaces in the tick report.
      failed += 1;
    }
  }

  return { users: pending.length, vindicated, invalidated, failed };
}

export type ReleaseStaleHoldsResult = { released: number };

/**
 * How long a per-call hold may sit unsettled before the tick releases it.
 *
 * A per-tool reservation (`tool-loop.ts`) is created immediately before the
 * network call and settled right after it — seconds, not minutes. A hold that
 * old belongs to a process that died between the two, and a hold nobody settles
 * keeps `reservedCents` raised forever, which is spending power lost with no
 * ledger entry to explain it.
 */
export const STALE_HOLD_MS = 15 * 60_000;

/**
 * Release per-tool holds whose process never came back.
 *
 * Only rows with `run_id IS NULL`: a run-level hold is reconciled by
 * `recoverStaleRuns`, and a running run must keep its allowance. Settlement
 * goes through `settleBudget`, so the bucket, the reservation state and the
 * reason commit together and a second pass changes nothing.
 */
export async function releaseStaleHolds(
  now: Date = new Date(),
  olderThanMs: number = STALE_HOLD_MS,
): Promise<ReleaseStaleHoldsResult> {
  const cutoff = new Date(now.getTime() - Math.max(0, olderThanMs));
  const stale = await db
    .select({ id: agentBudgetReservations.id })
    .from(agentBudgetReservations)
    .where(
      and(
        eq(agentBudgetReservations.state, "reserved"),
        isNull(agentBudgetReservations.runId),
        lte(agentBudgetReservations.createdAt, cutoff),
      ),
    );

  let released = 0;
  for (const row of stale) {
    const settled = await db.transaction((tx) =>
      settleBudget(tx, {
        reservationId: row.id,
        settlement: { state: "not_contacted" },
        reason: "Stale per-tool hold released by tick.",
      }),
    );
    if (settled) released += 1;
  }
  return { released };
}

export type CloseExpiredPeriodsResult = { closed: number };

/**
 * Close budget periods whose week is over.
 *
 * `agentBudgetPeriods.closedAt` was read by the admission path — a closed
 * period refuses holds ("该预算周期已关闭。") — and written by nobody, so a week
 * never actually ended: its numbers stayed open for reconciliation and there
 * was no record of the moment it stopped accepting holds. Closing is a
 * timestamp, not a delete: the ledger row is the accounting authority and stays
 * readable forever.
 */
export async function closeExpiredPeriods(
  now: Date = new Date(),
): Promise<CloseExpiredPeriodsResult> {
  const closed = await db
    .update(agentBudgetPeriods)
    .set({ closedAt: now })
    .where(
      and(
        lte(agentBudgetPeriods.periodEnd, now),
        isNull(agentBudgetPeriods.closedAt),
      ),
    )
    .returning({ id: agentBudgetPeriods.id });

  return { closed: closed.length };
}

export type TickStepName =
  | "recoverStaleRuns"
  | "expireStaleApprovals"
  | "failExhaustedJobs"
  | "settleDueDissents"
  | "closeExpiredPeriods"
  | "releaseStaleHolds"
  | "pruneRateLimits"
  | "pruneIdempotencyKeys"
  | "archiveOldOutbox";

export type TickStep = {
  name: TickStepName;
  /** Rows this step acted on, plus anything an operator needs to read. */
  run: () => Promise<{ count: number; detail?: Record<string, unknown> }>;
};

export type TickStepReport = {
  step: TickStepName;
  ok: boolean;
  count: number;
  error?: string;
  detail?: Record<string, unknown>;
};

export type TickReport = {
  startedAt: string;
  finishedAt: string;
  /** At least one step succeeded — the tick is not a total failure. */
  ok: boolean;
  /** Every step failed, which in practice means the database is unreachable. */
  allFailed: boolean;
  failed: number;
  steps: TickStepReport[];
};

/**
 * The tick, in order.
 *
 * Recovery runs first because it produces work the later steps never look at
 * (it rewinds tasks and settles budgets); the sweeps are independent of each
 * other, so their order is only about reading the log top-down.
 *
 * `deliverOutbox` is deliberately not here: sending mail is an outbound side
 * effect with its own retry schedule and a dry-run mode, and it stays on
 * `pnpm notify:deliver`. Chain the two in the same cron line.
 */
export function tickSteps(now: Date = new Date()): TickStep[] {
  return [
    {
      name: "recoverStaleRuns",
      run: async () => {
        const result = await recoverStaleRuns({ now });
        return {
          count: result.recovered,
          detail: {
            releasedCents: result.releasedCents,
            unknownCents: result.unknownCents,
          },
        };
      },
    },
    {
      name: "expireStaleApprovals",
      run: async () => {
        const result = await expireStaleApprovals({ now });
        return {
          count: result.expired,
          detail: { tasksRewound: result.tasksRewound },
        };
      },
    },
    {
      name: "failExhaustedJobs",
      run: async () => {
        const result = await failExhaustedJobs({ now });
        return { count: result.failed };
      },
    },
    {
      name: "settleDueDissents",
      run: async () => {
        const result = await settleDueDissents();
        return {
          count: result.vindicated + result.invalidated,
          detail: {
            users: result.users,
            vindicated: result.vindicated,
            invalidated: result.invalidated,
            failed: result.failed,
          },
        };
      },
    },
    {
      name: "closeExpiredPeriods",
      run: async () => ({
        count: (await closeExpiredPeriods(now)).closed,
      }),
    },
    {
      name: "releaseStaleHolds",
      run: async () => ({ count: (await releaseStaleHolds(now)).released }),
    },
    {
      name: "pruneRateLimits",
      run: async () => ({ count: (await pruneRateLimits({ now })).deleted }),
    },
    {
      name: "pruneIdempotencyKeys",
      run: async () => ({
        count: (await pruneIdempotencyKeys({ now })).deleted,
      }),
    },
    {
      name: "archiveOldOutbox",
      run: async () => ({ count: (await archiveOldOutbox({ now })).deleted }),
    },
  ];
}

/**
 * Run steps, isolating each one.
 *
 * One failing step must not stop the rest. A cron-owned process that aborts on
 * the first error turns a temporarily broken recovery pass into a permanently
 * missing TTL sweep, and the tables grow while the log shows one red line. The
 * error travels in the report (and the exit code) instead of in the stack.
 */
export async function runSteps(steps: TickStep[]): Promise<TickReport> {
  const startedAt = new Date();
  const results: TickStepReport[] = [];

  for (const step of steps) {
    try {
      const result = await step.run();
      results.push({
        step: step.name,
        ok: true,
        count: result.count,
        ...(result.detail ? { detail: result.detail } : {}),
      });
    } catch (error) {
      results.push({
        step: step.name,
        ok: false,
        count: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const failed = results.filter((result) => !result.ok).length;
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    ok: results.length > 0 && failed < results.length,
    allFailed: results.length > 0 && failed === results.length,
    failed,
    steps: results,
  };
}

/** One maintenance pass. Safe to call twice in a row: the second changes nothing. */
export async function runTick(
  options: { now?: Date } = {},
): Promise<TickReport> {
  return runSteps(tickSteps(options.now ?? new Date()));
}
