import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { runJobs, runs, steps, tasks } from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { stepMadeRequest } from "@/lib/domain/contact";
import { assertTransition } from "@/lib/domain/state";
import { settleBudget } from "./execution";
import { reopenConsumedApprovalsTx } from "./approvals";

/** A run that has been `running` for longer than this is considered abandoned. */
export const DEFAULT_STALE_RUN_MS = 15 * 60 * 1000;

function staleMs(override?: number): number {
  if (override !== undefined) return override;
  const minutes = Number(process.env.RUN_STALE_MINUTES ?? "");
  return Number.isFinite(minutes) && minutes > 0
    ? Math.trunc(minutes * 60_000)
    : DEFAULT_STALE_RUN_MS;
}

export type RecoveryResult = {
  recovered: number;
  releasedCents: number;
  unknownCents: number;
  ids: string[];
};

/**
 * Recover runs whose process died.
 *
 * The rule that matters: a run that may have reached a paid provider is settled
 * as UNKNOWN usage, not as zero. Offering the money back would make a crash the
 * cheapest way to call a model for free. Only a run with no provider contact on
 * record gets its hold released.
 */
export async function recoverStaleRuns(
  options: { olderThanMs?: number; now?: Date } = {},
): Promise<RecoveryResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - staleMs(options.olderThanMs));

  const stale = await db
    .select({
      id: runs.id,
      taskId: runs.taskId,
      userId: tasks.userId,
      startedAt: runs.startedAt,
    })
    .from(runs)
    .innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(and(eq(runs.status, "running"), lte(runs.startedAt, cutoff)));

  const ids: string[] = [];
  let releasedCents = 0;
  let unknownCents = 0;

  for (const run of stale) {
    const outcome = await db.transaction(async (tx) => {
      const runSteps = await tx
        .select({ type: steps.type, tool: steps.tool, output: steps.output })
        .from(steps)
        .where(eq(steps.runId, run.id));
      // Decided by an explicit "attempted" flag, falling back to the status
      // only for rows written before that flag existed. A "provider" label is
      // not evidence: MCP steps used to carry one even when the plan refused
      // them, which made an uncalled tool look like a charged one (5f332e7f 阻断 3).
      const contacted = runSteps.some((step) =>
        stepMadeRequest((step.output ?? {}) as Record<string, unknown>),
      );

      const settlement = await settleBudget(tx, {
        runId: run.id,
        settlement: contacted
          ? { state: "unknown_usage" }
          : { state: "not_contacted" },
        reason: "执行进程中断，运行记录由恢复流程收尾。",
      });

      const [failed] = await tx
        .update(runs)
        .set({
          status: "failed",
          endedAt: now,
          error: contacted
            ? "执行进程中断；可能已调用供应商，按未知用量记账。"
            : "执行进程中断；没有发出外部请求。",
        })
        .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
        .returning({ id: runs.id });
      if (!failed) return null;

      // Rewind the task so it can be retried deliberately, never silently.
      // Declared in the transition table instead of a bare UPDATE: this is the
      // one rollback the task machine allows, and it must stay visible there.
      assertTransition("task", "running", "planned");
      const [rewound] = await tx
        .update(tasks)
        .set({ status: "planned", updatedAt: now })
        .where(and(eq(tasks.id, run.taskId), eq(tasks.status, "running")))
        .returning({ id: tasks.id });

      // Reopen the approval this run consumed. Shared with the failed/rejected
      // retry path (`run.ts` `resetForRetry`): both rewind a task, and a rewind
      // that leaves the approval consumed produces a Run button that can only
      // ever fail with "Approval has already been consumed."
      const reopened = rewound
        ? await reopenConsumedApprovalsTx(tx, run.taskId)
        : 0;

      await tx
        .update(runJobs)
        .set({
          status: "failed",
          lastError: "执行进程中断，已由恢复流程收尾。",
          claimToken: null,
          leaseUntil: null,
          finishedAt: now,
        })
        .where(and(eq(runJobs.taskId, run.taskId), eq(runJobs.status, "running")));

      await logAuditTx(tx, {
        userId: run.userId,
        actor: "system",
        action: "run.recovered",
        target: run.id,
        before: { status: "running" },
        after: {
          status: "failed",
          settlement: settlement?.outcome ?? "no_hold",
          providerContacted: contacted,
          approvalReopened: reopened > 0,
        },
      });

      return { hold: settlement };
    });

    if (!outcome) continue;
    ids.push(run.id);
    if (outcome.hold?.outcome === "unknown_charged") {
      unknownCents += outcome.hold.unknownCents;
    } else {
      releasedCents += Math.max(0, outcome.hold?.settledCents ?? 0);
    }
  }

  return { recovered: ids.length, releasedCents, unknownCents, ids };
}

/** Count runs that look abandoned, without touching them. */
export async function countStaleRuns(
  options: { olderThanMs?: number; now?: Date } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - staleMs(options.olderThanMs));
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(runs)
    .where(and(eq(runs.status, "running"), lte(runs.startedAt, cutoff)));
  return Number(row?.n ?? 0);
}
