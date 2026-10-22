import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, checkins, goals, tasks } from "@/lib/db/schema";
import { getPolicyConfig } from "@/lib/policy/config";
import { ValidationError } from "@/lib/domain/errors";
import {
  buildNextLearningTask,
  LEARNING_TEMPLATES,
} from "@/lib/domain/learning";
import { createTask } from "./tasks/create";

export async function ensureNextLearningTask(userId: string) {
  const config = await getPolicyConfig();
  const [coach] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.role, "coach")))
    .limit(1);
  const [auditor] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.role, "auditor")))
    .limit(1);
  if (!coach || !auditor) {
    throw new ValidationError("Coach or Auditor is missing.");
  }

  const [goal] = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.userId, userId),
        eq(goals.status, "active"),
        eq(goals.domain, "learning"),
      ),
    )
    .orderBy(desc(goals.createdAt))
    .limit(1);
  if (!goal) {
    throw new ValidationError("Create a learning goal first.");
  }

  const [existing] = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.goalId, goal.id),
        inArray(tasks.template, [...LEARNING_TEMPLATES]),
        inArray(tasks.status, ["planned", "assigned", "submitted"]),
      ),
    )
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  if (existing) return existing;

  const [latestCheckin] = await db
    .select()
    .from(checkins)
    .where(eq(checkins.userId, userId))
    .orderBy(desc(checkins.date))
    .limit(1);
  const [lastAccepted] = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.goalId, goal.id),
        inArray(tasks.template, [...LEARNING_TEMPLATES]),
        inArray(tasks.status, ["accepted", "done"]),
      ),
    )
    .orderBy(desc(tasks.acceptedAt))
    .limit(1);

  const daysSinceAccepted = lastAccepted?.acceptedAt
    ? (Date.now() - lastAccepted.acceptedAt.getTime()) / 86_400_000
    : null;
  const retest =
    Boolean(latestCheckin?.errorTags.length) &&
    daysSinceAccepted !== null &&
    daysSinceAccepted >= config.learning.nextTask.retestAfterDays;

  const draft = buildNextLearningTask({
    goalTitle: goal.title,
    goalTarget: goal.target,
    latestRecallScore: latestCheckin?.recallScore ?? null,
    errorTags: latestCheckin?.errorTags ?? [],
    retest,
    config: config.learning,
  });

  return createTask(
    {
      goalId: goal.id,
      title: draft.title,
      description: draft.description,
      assigneeId: coach.id,
      auditorId: auditor.id,
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 0,
      acceptanceCriteria: draft.acceptanceCriteria,
      acceptanceChecklist: draft.acceptanceChecklist,
      estimateMin: draft.estimateMin,
      template: draft.template,
      createdBy: "agent",
    },
    userId,
  );
}
