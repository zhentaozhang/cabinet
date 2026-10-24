import { and, eq, isNotNull, sql } from "drizzle-orm";
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

/**
 * Ask a human to approve an external action.
 *
 * `tx` is mandatory: `pg_advisory_xact_lock` lives exactly as long as the
 * transaction that took it. Falling back to `db` put the lock in an implicit
 * single-statement transaction that released it the moment the statement
 * returned, so two concurrent requests both saw "no pending approval" and
 * inserted duplicates — a lock that silently did nothing. The lock and the
 * insert must therefore share one caller-owned transaction.
 */
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
  tx: Tx,
) {
  // TypeScript cannot stop an untyped caller from omitting the transaction,
  // and continuing without it would recreate the unprotected path silently.
  if (!tx) {
    throw new Error(
      "requestApproval requires a caller transaction (tx) so the advisory lock and the insert commit together.",
    );
  }
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`approval:${input.taskId}:${input.action}`}))`,
  );
  const existing = await loadLatestApproval(input.taskId, tx);
  if (existing?.status === "pending") return existing;

  const [created] = await tx
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
    tx,
  );

  return created;
}

export type ExpiredApproval = {
  expired: boolean;
  taskId: string | null;
  /** True when the task was parked in `awaiting_approval` and went back to `planned`. */
  taskRewound: boolean;
};

/**
 * Hand a spent approval back to the task it was made for.
 *
 * `decideRun` denies a task whose latest approval is `approved` **and already
 * consumed** with "Approval has already been consumed." — the branch exists so a
 * second run cannot ride on one human yes. Every rewind path therefore has to
 * decide what happens to the consumed approval, and leaving it consumed creates a
 * button that always fails: the task is `planned` (so the Run button is enabled)
 * but the policy denies every attempt, and `awaitApproval` is never reached, so
 * the user cannot even ask again.
 *
 * Reopening keeps the human decision with the task: a retry the user pressed is
 * itself the yes, and the approval still gates whatever runs next.
 *
 * Shared on purpose. The recovery sweep and the failed/rejected retry path both
 * rewind a task; when only one of them reopened the approval, the other one left
 * exactly the trap described above.
 */
export async function reopenConsumedApprovalsTx(
  tx: Tx,
  taskId: string,
): Promise<number> {
  const reopened = await tx
    .update(approvals)
    .set({ consumedAt: null })
    .where(
      and(
        eq(approvals.taskId, taskId),
        eq(approvals.status, "approved"),
        isNotNull(approvals.consumedAt),
      ),
    )
    .returning({ id: approvals.id });
  return reopened.length;
}

/**
 * Expire one pending approval inside the caller's transaction.
 *
 * Two callers need exactly this: a human who opens an approval past its
 * `expiresAt` (it must flip to `expired` right then), and the maintenance tick,
 * which sweeps the approvals nobody ever came back to. Sharing one body keeps a
 * single definition of what "expired" does to the task — a second copy would
 * drift, and the drift decides whether a task is stuck in `awaiting_approval`
 * forever.
 *
 * The update is conditional on `status = 'pending'`, so a sweep racing the
 * user's click, or two sweeps racing each other, cannot expire the same row (and
 * write two audit events) twice.
 */
export async function expireApprovalInTx(
  tx: Tx,
  input: { approvalId: string; userId?: string; now?: Date },
): Promise<ExpiredApproval> {
  const now = input.now ?? new Date();
  const [expired] = await tx
    .update(approvals)
    .set({ status: "expired", decidedAt: now })
    .where(
      and(
        eq(approvals.id, input.approvalId),
        eq(approvals.status, "pending"),
        input.userId ? eq(approvals.userId, input.userId) : undefined,
      ),
    )
    .returning();
  if (!expired) return { expired: false, taskId: null, taskRewound: false };

  let taskRewound = false;
  if (expired.taskId) {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.id, expired.taskId), eq(tasks.userId, expired.userId)),
      );
    if (task?.status === "awaiting_approval") {
      assertTransition("task", task.status, "planned");
      const [updated] = await tx
        .update(tasks)
        .set({ status: "planned", updatedAt: now })
        .where(
          and(
            eq(tasks.id, task.id),
            eq(tasks.userId, expired.userId),
            eq(tasks.status, "awaiting_approval"),
          ),
        )
        .returning({ id: tasks.id });
      taskRewound = Boolean(updated);
    }
  }

  await logAuditTx(tx, {
    userId: expired.userId,
    actor: "system",
    action: "approval.expire",
    target: expired.id,
    before: { status: "pending" },
    after: {
      status: "expired",
      taskId: expired.taskId,
      taskRewound,
    },
  });

  return { expired: true, taskId: expired.taskId ?? null, taskRewound };
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
    // The same transaction body the maintenance sweep uses, so an approval
    // expired here and one expired by cron leave identical rows behind.
    await db.transaction((tx) =>
      expireApprovalInTx(tx, { approvalId, userId }),
    );
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
