import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { approvals, tasks } from "@/lib/db/schema";
import { logAudit } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { assertTransition } from "@/lib/domain/state";
import { ConflictError, NotFoundError } from "@/lib/domain/errors";
import { loadLatestApproval } from "./execution";

export async function requestApproval(input: {
  userId: string;
  taskId: string;
  action: string;
  reason: string;
  estimatedCostCents: number;
}) {
  const existing = await loadLatestApproval(input.taskId);
  if (existing?.status === "pending") return existing;

  const [created] = await db
    .insert(approvals)
    .values({
      id: newId("appr"),
      userId: input.userId,
      taskId: input.taskId,
      action: input.action,
      payload: {
        taskId: input.taskId,
        actionType: input.action,
        estimatedCostCents: input.estimatedCostCents,
        reason: input.reason,
      },
      status: "pending",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning();
  return created;
}

export async function decideApproval(
  approvalId: string,
  decision: "approve" | "reject",
  reason: string | undefined,
  userId: string,
) {
  const [approval] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId));
  if (!approval || approval.userId !== userId) {
    throw new NotFoundError("Approval not found");
  }
  if (approval.status !== "pending") {
    throw new ConflictError(`Approval is already ${approval.status}.`);
  }

  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(approvals)
      .set({
        status: decision === "approve" ? "approved" : "rejected",
        reason: reason ?? null,
        decidedAt: new Date(),
      })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
      .returning();
    if (!updated) throw new ConflictError("Approval state changed; retry.");

    if (approval.taskId) {
      const [task] = await tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.id, approval.taskId),
            eq(tasks.userId, approval.userId),
          ),
        );
      if (!task) throw new NotFoundError("Task not found");
      const target = decision === "approve" ? "approved" : "cancelled";
      assertTransition("task", task.status, target);
      const [taskUpdated] = await tx
        .update(tasks)
        .set({ status: target, updatedAt: new Date() })
        .where(
          and(
            eq(tasks.id, task.id),
            eq(tasks.userId, approval.userId),
            eq(tasks.status, task.status),
          ),
        )
        .returning();
      if (!taskUpdated) throw new ConflictError("Task state changed; retry.");
    }
  });

  await logAudit({
    userId: approval.userId,
    actor: "user",
    action: decision === "approve" ? "approval.grant" : "approval.deny",
    target: approval.id,
    before: { status: "pending" },
    after: { status: decision, reason: reason ?? null },
  });
}
