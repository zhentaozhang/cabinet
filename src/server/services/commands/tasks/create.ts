import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import type { AcceptanceItem } from "@/lib/db/schema";
import { agents, goals, tasks } from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { configuredSearchProviders } from "@/lib/connectors/registry";
import { newId } from "@/lib/ids";
import { assertTransition } from "@/lib/domain/state";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/domain/errors";
import { getPolicyConfig } from "@/lib/policy/config";
import { recalculateGoalProgress } from "../progress";

export async function promoteSuggestion(taskId: string, userId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task || task.userId !== userId) {
    throw new NotFoundError("Task not found");
  }
  if (task.status !== "suggested") {
    throw new ConflictError(`Task is ${task.status}, not a suggestion.`);
  }
  assertTransition("task", "suggested", "planned");
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(tasks)
      .set({ status: "planned", updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "suggested")))
      .returning();
    if (!updated) throw new ConflictError("Task state changed; retry.");

    await logAuditTx(tx, {
      userId: task.userId,
      actor: "user",
      action: "task.promote",
      target: taskId,
      before: { status: "suggested" },
      after: { status: "planned" },
    });

    return updated;
  });
}

const WEB_TOOLS = ["web_search", "web_fetch"];

/**
 * Default checklist for research work.
 *
 * Two conditions, both necessary: the assignee must be allowed to reach the
 * web, and a search provider must actually be configured. Without a key the
 * run cannot persist a single evidence row, so demanding evidence would make
 * every default research task fail for a reason the user cannot act on.
 */
async function defaultEvidenceChecklist(
  assigneeId: string,
  userId: string,
): Promise<AcceptanceItem[] | null> {
  const [agent] = await db
    .select({ tools: agents.tools })
    .from(agents)
    .where(and(eq(agents.id, assigneeId), eq(agents.userId, userId)));
  if (!agent) return null;
  if (!agent.tools.some((tool) => WEB_TOOLS.includes(tool))) return null;
  if (configuredSearchProviders().length === 0) return null;
  return [
    { type: "min_evidence", value: 3, required: true },
    { type: "section", value: "来源", required: true },
  ];
}

export async function createTask(
  input: {
    goalId?: string | null;
    title: string;
    description: string;
    assigneeId: string;
    auditorId: string;
    actionType: string;
    resource: string;
    estimatedCostCents: number;
    acceptanceCriteria: string;
    acceptanceChecklist?: AcceptanceItem[] | null;
    estimateMin: number;
    dueAt?: string | null;
    template?: string | null;
    createdBy?: "user" | "agent" | "system";
  },
  userId: string,
) {
  const title = input.title.trim();
  const description = input.description.trim();
  const acceptanceCriteria = input.acceptanceCriteria.trim();
  if (!title || !description || !acceptanceCriteria) {
    throw new ValidationError("Title, description and criteria are required.");
  }
  if (input.assigneeId === input.auditorId) {
    throw new ValidationError("Assignee and auditor must differ.");
  }
  if (input.actionType === "spend" && input.estimatedCostCents <= 0) {
    throw new ValidationError("Spend tasks require a positive estimated cost.");
  }

  const [assignee] = await db
    .select({ id: agents.id, userId: agents.userId })
    .from(agents)
    .where(eq(agents.id, input.assigneeId));
  const [auditor] = await db
    .select({ id: agents.id, userId: agents.userId })
    .from(agents)
    .where(eq(agents.id, input.auditorId));
  if (
    !assignee ||
    !auditor ||
    assignee.userId !== userId ||
    auditor.userId !== userId
  ) {
    throw new ValidationError("Assignee or auditor not found.");
  }

  if (input.goalId) {
    const [goal] = await db
      .select({ id: goals.id, userId: goals.userId })
      .from(goals)
      .where(eq(goals.id, input.goalId));
    if (!goal || goal.userId !== userId) {
      throw new ValidationError("Goal not found.");
    }
  }

  const dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (dueAt && Number.isNaN(dueAt.getTime())) {
    throw new ValidationError("Invalid due date.");
  }

  const id = newId("tsk");
  const policy = input.goalId ? await getPolicyConfig() : null;
  // A task handed to a web-capable Agent is a research task: without an
  // evidence requirement the Auditor could accept prose with no sources.
  const checklist =
    input.acceptanceChecklist ??
    (await defaultEvidenceChecklist(input.assigneeId, userId));
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(tasks)
      .values({
        id,
        userId: userId,
        goalId: input.goalId ?? null,
        title,
        description,
        assigneeId: input.assigneeId,
        auditorId: input.auditorId,
        status: "planned",
        priority: 2,
        dueAt,
        acceptanceCriteria,
        acceptanceChecklist: checklist,
        estimateMin: Math.max(1, input.estimateMin),
        actionType: input.actionType,
        resource: input.resource,
        estimatedCostCents: Math.max(0, input.estimatedCostCents),
        template: input.template ?? null,
        createdBy: input.createdBy ?? "user",
      })
      .returning();

    if (input.goalId && policy) {
      await recalculateGoalProgress(
        tx,
        userId,
        input.goalId,
        policy.learning,
      );
    }

    await logAuditTx(tx, {
      userId: userId,
      actor: input.createdBy ?? "user",
      action: "task.create",
      target: id,
      before: null,
      after: {
        title,
        assigneeId: input.assigneeId,
        auditorId: input.auditorId,
        actionType: input.actionType,
        resource: input.resource,
      },
    });

    return created;
  });
}
