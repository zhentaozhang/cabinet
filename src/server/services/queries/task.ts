import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  approvals,
  artifacts,
  auditEvents,
  goals,
  runs,
  steps,
  tasks,
} from "@/lib/db/schema";
export async function getTaskData(taskId: string, userId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task || task.userId !== userId) return null;
  const taskRuns = await db
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(asc(runs.createdAt));
  const runIds = taskRuns.map((r) => r.id);
  const runSteps = runIds.length
    ? await db
        .select()
        .from(steps)
        .where(inArray(steps.runId, runIds))
        .orderBy(asc(steps.idx))
    : [];
  const taskArtifacts = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .orderBy(desc(artifacts.createdAt));
  const [goal] = task.goalId
    ? await db.select().from(goals).where(eq(goals.id, task.goalId))
    : [null];
  const [assignee] = task.assigneeId
    ? await db.select().from(agents).where(eq(agents.id, task.assigneeId))
    : [null];
  const [auditor] = task.auditorId
    ? await db.select().from(agents).where(eq(agents.id, task.auditorId))
    : [null];
  const taskApprovals = await db
    .select()
    .from(approvals)
    .where(eq(approvals.taskId, taskId));
  const taskAudit = await db
    .select()
    .from(auditEvents)
    .where(
      and(eq(auditEvents.userId, userId), eq(auditEvents.target, taskId)),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(10);
  return {
    task,
    goal: goal ?? null,
    assignee: assignee ?? null,
    auditor: auditor ?? null,
    runs: taskRuns,
    steps: runSteps,
    artifacts: taskArtifacts,
    approvals: taskApprovals,
    audit: taskAudit,
  };
}
