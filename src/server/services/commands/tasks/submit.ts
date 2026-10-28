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

    // 无论这次是不是"又一次提交"，都要带着读到的状态去写这一行。
    //
    // 曾经这里在 status === "submitted" 时直接跳过更新：读到的状态是
    // submitted，"再次提交"是允许的（重交同一份草稿），所以看起来无事可做。
    // 但跳过写入就等于没有问过"这行还是不是 submitted"——审计恰好在这两步
    // 之间把任务判成 accepted，这份新答案照样落库、接口返回成功，任务却早已
    // 定性，再也没有人会拿它去验收；用户看到的是"提交成功"和一个已经通过的
    // 旧结论。写这一行本身就是那把锁：读到的状态没变才算提交成立。
    if (task.status !== "submitted") {
      assertTransition("task", task.status, "submitted");
    }
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
