import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { assertTransition } from "@/lib/domain/state";
import { ConflictError, NotFoundError } from "@/lib/domain/errors";

export async function markTaskDone(taskId: string, userId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
  if (!task) throw new NotFoundError("Task not found");
  if (task.status !== "accepted") {
    throw new ConflictError(`Task is ${task.status}, not accepted.`);
  }
  assertTransition("task", task.status, "done");

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(tasks)
      .set({ status: "done", updatedAt: new Date() })
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.userId, userId),
          eq(tasks.status, "accepted"),
        ),
      )
      .returning();
    if (!updated) throw new ConflictError("Task state changed; retry.");

    await logAuditTx(tx, {
      userId,
      actor: "user",
      action: "task.done",
      target: taskId,
      before: { status: "accepted" },
      after: { status: "done" },
    });

    return updated;
  });
}
