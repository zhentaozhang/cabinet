import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { assertTransition } from "@/lib/domain/state";
import { taskActions } from "@/lib/domain/task-actions";
import { ConflictError, NotFoundError } from "@/lib/domain/errors";

/**
 * Cancel a task.
 *
 * Cancelling means "stop here", not "delete". The artifacts, evidence, audit
 * rows and money already spent stay exactly as they were — a cancelled task
 * that erased its own record would be the single easiest way to hide a bad run.
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

    await logAuditTx(tx, {
      userId,
      actor: "user",
      action: "task.cancel",
      target: taskId,
      before: { status: task.status },
      after: { status: "cancelled", reason: note || null },
    });

    return { id: updated.id, status: "cancelled" };
  });
}
