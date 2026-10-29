import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  approvals,
  artifacts,
  auditEvents,
  evidence,
  goals,
  runs,
  steps,
  tasks,
  users,
} from "@/lib/db/schema";
export async function getTaskData(taskId: string, userId: string) {
  // Ownership is enforced in SQL so a foreign task is never fetched at all.
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
  if (!task) return null;

  const [
    taskRuns,
    taskArtifacts,
    goalRows,
    assigneeRows,
    auditorRows,
    taskApprovals,
    taskAudit,
    userRows,
    overrideRows,
    taskEvidence,
  ] = await Promise.all([
    db
      .select()
      .from(runs)
      .where(eq(runs.taskId, taskId))
      .orderBy(asc(runs.createdAt)),
    db
      .select()
      .from(artifacts)
      .where(eq(artifacts.taskId, taskId))
      .orderBy(desc(artifacts.createdAt)),
    task.goalId
      ? db.select().from(goals).where(eq(goals.id, task.goalId))
      : Promise.resolve([]),
    task.assigneeId
      ? db.select().from(agents).where(eq(agents.id, task.assigneeId))
      : Promise.resolve([]),
    task.auditorId
      ? db.select().from(agents).where(eq(agents.id, task.auditorId))
      : Promise.resolve([]),
    // 审批行按时间倒序：一条任务可能留下多行（每次运行花掉一条），没有
    // ORDER BY 时卡片里的「历史」顺序随物理行序变化，读数没有意义。
    db
      .select()
      .from(approvals)
      .where(eq(approvals.taskId, taskId))
      .orderBy(desc(approvals.createdAt), desc(approvals.id)),
    db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.userId, userId), eq(auditEvents.target, taskId)),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(10),
    db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId)),
    // 人工判定单独取一条：audit 数组只拉最近 10 行，人判之后还能追加别的
    // 审计事件，靠窗口筛会让"曾经判过"的记录随事件增多而消失。
    db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, userId),
          eq(auditEvents.target, taskId),
          eq(auditEvents.action, "audit.override"),
        ),
      )
      .orderBy(desc(auditEvents.seq))
      .limit(1),
    db
      .select()
      .from(evidence)
      .where(eq(evidence.taskId, taskId))
      .orderBy(asc(evidence.createdAt)),
  ]);

  const runIds = taskRuns.map((run) => run.id);
  const runSteps = runIds.length
    ? await db
        .select()
        .from(steps)
        .where(inArray(steps.runId, runIds))
        .orderBy(asc(steps.idx))
    : [];

  return {
    timezone: userRows[0]?.timezone ?? "UTC",
    task,
    goal: goalRows[0] ?? null,
    assignee: assigneeRows[0] ?? null,
    auditor: auditorRows[0] ?? null,
    runs: taskRuns,
    steps: runSteps,
    artifacts: taskArtifacts,
    evidence: taskEvidence,
    approvals: taskApprovals,
    audit: taskAudit,
    override: overrideRows[0] ?? null,
  };
}
