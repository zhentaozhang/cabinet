import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { artifacts, tasks } from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { assertTransition } from "@/lib/domain/state";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/domain/errors";

const SUBMITTABLE = ["planned", "assigned", "submitted", "rejected"] as const;

export async function submitTaskArtifact(
  input: { taskId: string; title?: string; content: string },
  userId: string,
) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, input.taskId), eq(tasks.userId, userId)));
  if (!task) throw new NotFoundError("Task not found");
  if (!task.assigneeId || !task.auditorId) {
    throw new ValidationError("Task needs an assignee and an auditor.");
  }
  if (task.actionType !== "internal") {
    throw new ValidationError("Only internal tasks accept learner submissions.");
  }
  if (!SUBMITTABLE.includes(task.status as (typeof SUBMITTABLE)[number])) {
    throw new ConflictError(`Task is ${task.status}, not accepting submissions.`);
  }

  const content = input.content.trim();
  if (!content) throw new ValidationError("Submission content is required.");

  return db.transaction(async (tx) => {
    const artifactId = newId("art");
    await tx.insert(artifacts).values({
      id: artifactId,
      runId: null,
      taskId: task.id,
      type: "markdown",
      title: input.title?.trim() || task.title,
      content,
      submittedBy: "user",
      sourceType: "user_input",
    });

    if (task.status !== "submitted") {
      assertTransition("task", task.status, "submitted");
      const [updated] = await tx
        .update(tasks)
        .set({ status: "submitted", updatedAt: new Date() })
        .where(
          and(
            eq(tasks.id, task.id),
            eq(tasks.userId, userId),
            eq(tasks.status, task.status),
          ),
        )
        .returning({ id: tasks.id });
      if (!updated) throw new ConflictError("Task state changed; retry.");
    }

    await logAuditTx(tx, {
      userId,
      actor: "user",
      action: "task.submit",
      target: task.id,
      before: { status: task.status },
      after: { status: "submitted", artifactId, submittedBy: "user" },
    });

    return { artifactId };
  });
}
