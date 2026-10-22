import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import type { AcceptanceItem } from "@/lib/db/schema";
import { agents, goals, tasks } from "@/lib/db/schema";
import { logAudit } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { assertTransition } from "@/lib/domain/state";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/domain/errors";

export async function promoteSuggestion(taskId: string, userId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task || task.userId !== userId) {
    throw new NotFoundError("Task not found");
  }
  if (task.status !== "suggested") {
    throw new ConflictError(`Task is ${task.status}, not a suggestion.`);
  }
  assertTransition("task", "suggested", "planned");
  const [updated] = await db
    .update(tasks)
    .set({ status: "planned", updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "suggested")))
    .returning();
  if (!updated) throw new ConflictError("Task state changed; retry.");

  await logAudit({
    userId: task.userId,
    actor: "user",
    action: "task.promote",
    target: taskId,
    before: { status: "suggested" },
    after: { status: "planned" },
  });

  return updated;
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
  const [created] = await db
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
      acceptanceChecklist: input.acceptanceChecklist ?? null,
      estimateMin: Math.max(1, input.estimateMin),
      actionType: input.actionType,
      resource: input.resource,
      estimatedCostCents: Math.max(0, input.estimatedCostCents),
      createdBy: "user",
    })
    .returning();

  await logAudit({
    userId: userId,
    actor: "user",
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
}
