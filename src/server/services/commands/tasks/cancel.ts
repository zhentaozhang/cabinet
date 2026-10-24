import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { runJobs, runs, tasks } from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { assertTransition } from "@/lib/domain/state";
import { taskActions } from "@/lib/domain/task-actions";
import { ConflictError, NotFoundError } from "@/lib/domain/errors";
import { settleBudget } from "./execution";

/**
 * Cancel a task.
 *
 * Cancelling means "stop here", not "delete". The artifacts, evidence, audit
 * rows and money already spent stay exactly as they were — a cancelled task
 * that erased its own record would be the single easiest way to hide a bad run.
 *
 * A running task is cancellable, so the same transaction has to end everything
 * still live underneath it. A status-only cancel was not an interruption: the
 * run kept writing after commit, its budget hold stayed `reserved` for the rest
 * of the week, and a queued job kept the task's slot occupied.
 *
 * The hold is settled as UNKNOWN rather than released. The run was in flight, so
 * a provider call may already have happened; handing that money back would make
 * "cancel mid-run" the cheapest way to reach a model for free.
 */
export async function cancelTask(
  taskId: string,
  userId: string,
  reason = "",
) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
  if (!task) throw new NotFoundError("Task not found");

  const gate = taskActions({
    status: task.status,
    hasAssignee: Boolean(task.assigneeId),
    hasAuditor: Boolean(task.auditorId),
  });
  if (!gate.cancel.allowed) throw new ConflictError(gate.cancel.reason);
  assertTransition("task", task.status, "cancelled");

  const note = reason.trim().slice(0, 200);
  const now = new Date();

  return db.transaction(async (tx) => {
    // Conditional on the status we read, so two people cancelling at once
    // cannot both write an audit row for the same transition.
    const [updated] = await tx
      .update(tasks)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.userId, userId),
          eq(tasks.status, task.status),
        ),
      )
      .returning({ id: tasks.id });
    if (!updated) throw new ConflictError("Task state changed; retry.");

    // Fail the run in flight. Its own success path only writes the task back
    // when that task is still `running`, so a run that finishes after this
    // commit loses the race instead of reviving a cancelled task.
    const stoppedRuns = await tx
      .update(runs)
      .set({ status: "failed", endedAt: now, error: "任务被取消。" })
      .where(and(eq(runs.taskId, taskId), eq(runs.status, "running")))
      .returning({ id: runs.id });

    // settleBudget is idempotent (a hold that is not `reserved` is left alone),
    // so a run that already settled — or that never had a hold — costs nothing.
    for (const run of stoppedRuns) {
      await settleBudget(tx, {
        runId: run.id,
        settlement: { state: "unknown_usage" },
        reason: "任务被取消；运行途中可能已调用供应商，按未知用量记账。",
      });
    }

    // Queued jobs would otherwise start a cancelled task, and a claimed job
    // would write its result back. Clearing the claim token is what refuses
    // that late write-back (finishRunJob matches on token and `running`).
    const stoppedJobs = await tx
      .update(runJobs)
      .set({
        status: "failed",
        lastError: "任务被取消。",
        claimToken: null,
        leaseUntil: null,
        finishedAt: now,
      })
      .where(
        and(
          eq(runJobs.taskId, taskId),
          inArray(runJobs.status, ["queued", "running"]),
        ),
      )
      .returning({ id: runJobs.id });

    await logAuditTx(tx, {
      userId,
      actor: "user",
      action: "task.cancel",
      target: taskId,
      before: { status: task.status },
      after: {
        status: "cancelled",
        reason: note || null,
        // Without the counts, "cancelled while running" and "cancelled while
        // idle" leave the same trace, and nobody can tell whether money was
        // charged as unknown.
        cancelledRuns: stoppedRuns.length,
        cancelledJobs: stoppedJobs.length,
      },
    });

    return { id: updated.id, status: "cancelled" };
  });
}
