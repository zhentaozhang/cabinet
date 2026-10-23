import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { approvals, tasks } from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { assertTransition } from "@/lib/domain/state";
import { ConflictError, NotFoundError } from "@/lib/domain/errors";
import type { Tx } from "../../shared/tx";
import { enqueueNotification, notices } from "../notify";
import {
  createStandingGrantFromApproval,
  type RememberInput,
} from "./grants";
import { loadLatestApproval } from "./execution";

export async function requestApproval(
  input: {
    userId: string;
    taskId: string;
    title: string;
    resource: string;
    dueAt: Date | null;
    action: string;
    reason: string;
    estimatedCostCents: number;
  },
  tx?: Tx,
) {
  const client = tx ?? db;
  await client.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`approval:${input.taskId}:${input.action}`}))`,
  );
  const existing = await loadLatestApproval(input.taskId, tx);
  if (existing?.status === "pending") return existing;

  const [created] = await client
    .insert(approvals)
    .values({
      id: newId("appr"),
      userId: input.userId,
      taskId: input.taskId,
      action: input.action,
      payload: {
        taskId: input.taskId,
        title: input.title,
        actionType: input.action,
        resource: input.resource,
        dueAt: input.dueAt ? input.dueAt.toISOString() : null,
        estimatedCostCents: input.estimatedCostCents,
        reason: input.reason,
      },
      status: "pending",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning();

  await enqueueNotification(
    {
      userId: input.userId,
      kind: "approval",
      targetType: "approval",
      targetId: created.id,
      ...notices.approval({
        taskId: input.taskId,
        taskTitle: input.title,
        actionType: input.action,
      }),
    },
    client,
  );

  return created;
}

export async function decideApproval(
  approvalId: string,
  decision: "approve" | "reject",
  reason: string | undefined,
  userId: string,
  options: { remember?: RememberInput } = {},
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
  if (approval.expiresAt && approval.expiresAt.getTime() <= Date.now()) {
    await db.transaction(async (tx) => {
      const [expired] = await tx
        .update(approvals)
        .set({ status: "expired", decidedAt: new Date() })
        .where(
          and(
            eq(approvals.id, approvalId),
            eq(approvals.userId, userId),
            eq(approvals.status, "pending"),
          ),
        )
        .returning();
      if (!expired) return;
      if (approval.taskId) {
        const [task] = await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.id, approval.taskId),
              eq(tasks.userId, userId),
            ),
          );
        if (task?.status === "awaiting_approval") {
          assertTransition("task", task.status, "planned");
          await tx
            .update(tasks)
            .set({ status: "planned", updatedAt: new Date() })
            .where(
              and(
                eq(tasks.id, task.id),
                eq(tasks.userId, userId),
                eq(tasks.status, "awaiting_approval"),
              ),
            );
        }
      }
      await logAuditTx(tx, {
        userId,
        actor: "system",
        action: "approval.expire",
        target: approvalId,
        before: { status: "pending" },
        after: { status: "expired", taskId: approval.taskId },
      });
    });
    throw new ConflictError(
      "Approval expired; the task was returned to planned.",
    );
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

      // "记住这类决定" only exists for an approval, and only on approve: a
      // rejection must never mint standing authority.
      if (decision === "approve" && options.remember && task.assigneeId) {
        await createStandingGrantFromApproval(
          {
            userId: approval.userId,
            agentId: task.assigneeId,
            resource: task.resource,
            actionType: task.actionType,
            approvalId: approval.id,
            taskTitle: task.title,
            remember: options.remember,
          },
          tx,
        );
      }
    }

    await logAuditTx(tx, {
      userId: approval.userId,
      actor: "user",
      action: decision === "approve" ? "approval.grant" : "approval.deny",
      target: approval.id,
      before: { status: "pending" },
      after: { status: decision, reason: reason ?? null },
    });
  });
}
