import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import type { AcceptanceResult } from "@/lib/db/schema";
import {
  agents,
  artifacts,
  goals,
  runs,
  steps,
  tasks,
} from "@/lib/db/schema";
import { logAudit } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { getPolicyConfig } from "@/lib/policy/config";
import { decideAudit } from "@/lib/domain/policy";
import { assertTransition } from "@/lib/domain/state";
import {
  ConflictError,
  NotFoundError,
  PolicyDenied,
} from "@/lib/domain/errors";
import { checklistPassed, evaluateAcceptance } from "@/lib/domain/acceptance";
import { clamp } from "../../shared/numbers";

export async function auditTask(taskId: string, userId: string) {
  try {
    return await auditTaskInner(taskId, userId);
  } catch (error) {
    await db
      .update(tasks)
      .set({ status: "submitted", updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "auditing")));
    throw error;
  }
}

async function auditTaskInner(taskId: string, userId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task || task.userId !== userId) {
    throw new NotFoundError("Task not found");
  }
  if (!task.auditorId) throw new ConflictError("Task has no auditor");
  const [auditor] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, task.auditorId));
  if (!auditor || auditor.userId !== userId) {
    throw new NotFoundError("Auditor not found");
  }

  const config = await getPolicyConfig();
  const auditDecision = decideAudit({
    actor: {
      id: auditor.id,
      role: auditor.role,
      status: auditor.status,
      lifecycleStage: auditor.lifecycleStage,
      autonomyLevel: auditor.autonomyLevel,
      trustScore: auditor.trustScore,
      successCount: auditor.successCount,
    },
    task: {
      assigneeId: task.assigneeId,
      auditorId: task.auditorId,
      actionType: task.actionType,
      resource: task.resource,
      requiresApproval: task.requiresApproval,
      estimatedCostCents: task.estimatedCostCents,
      approvalThresholdCents: task.approvalThresholdCents,
      status: task.status,
    },
  });
  if (auditDecision.effect === "deny") {
    throw new PolicyDenied(auditDecision.reason);
  }

  assertTransition("task", task.status, "auditing");
  const [locked] = await db
    .update(tasks)
    .set({ status: "auditing", updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "submitted")))
    .returning();
  if (!locked) throw new ConflictError("Task is not submitted for audit.");

  const taskRuns = await db
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.createdAt));
  const [artifact] = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .orderBy(desc(artifacts.createdAt))
    .limit(1);

  const runId = newId("run");
  await db.insert(runs).values({
    id: runId,
    taskId,
    agentId: auditor.id,
    status: "running",
    mode: "demo",
    startedAt: new Date(),
    replayKey: `audit_${taskId}_${taskRuns.length + 1}`,
  });

  let idx = 0;
  const addStep = async (input: {
    type: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
  }) => {
    idx += 1;
    await db.insert(steps).values({
      id: newId("stp"),
      runId,
      idx,
      type: input.type,
      input: input.input,
      output: input.output,
      tokensIn: 80,
      tokensOut: 40,
      latencyMs: 100,
    });
  };

  await addStep({
    type: "context",
    input: { task: taskId, artifact: artifact?.id ?? null },
    output: { found: Boolean(artifact) },
  });

  let pass = Boolean(artifact);
  let reason = pass
    ? "产物存在，验收标准逐条对照通过。"
    : "没有找到可验收的产物。";
  let acceptanceReport: AcceptanceResult[] | null = null;

  if (artifact && task.acceptanceChecklist?.length) {
    acceptanceReport = evaluateAcceptance(
      artifact.content,
      task.acceptanceChecklist,
    );
    pass = checklistPassed(acceptanceReport);
    const failed = acceptanceReport.filter(
      (result) => result.item.required && !result.passed,
    );
    reason = pass
      ? "验收清单逐项通过。"
      : `验收清单未通过：${failed
          .map((result) => result.reason)
          .join("；")}`;
  } else if (artifact) {
    const requiresRubric =
      task.acceptanceCriteria.includes("评分标准") ||
      task.acceptanceCriteria.toLowerCase().includes("rubric");
    if (requiresRubric) {
      const hasRubric =
        artifact.content.includes("## 评分标准") ||
        artifact.content.includes("| 维度 |");
      if (!hasRubric) {
        pass = false;
        reason = "缺少评分标准（rubric），无法判断题目质量。请补充后重新提交。";
      }
    }
  }

  await addStep({
    type: "audit",
    input: {
      acceptanceCriteria: task.acceptanceCriteria,
      checklist: task.acceptanceChecklist ?? null,
    },
    output: { pass, reason, checklist: acceptanceReport },
  });

  await db
    .update(runs)
    .set({
      status: "succeeded",
      endedAt: new Date(),
      costCents: 0.4,
      tokensIn: 160,
      tokensOut: 80,
    })
    .where(eq(runs.id, runId));

  const nextStatus = pass ? "accepted" : "rejected";
  const executor = task.assigneeId
    ? ((await db
        .select()
        .from(agents)
        .where(eq(agents.id, task.assigneeId)))[0] ?? null)
    : null;

  const [decided] = await db
    .update(tasks)
    .set({
      status: nextStatus,
      acceptanceReport,
      updatedAt: new Date(),
      ...(pass
        ? {
            acceptedAt: new Date(),
            acceptedAutonomyLevel: executor?.autonomyLevel ?? null,
          }
        : {}),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "auditing")))
    .returning();
  if (!decided) throw new ConflictError("Task left the auditing state.");

  if (executor) {
    const nextRejectStreak = pass ? 0 : executor.rejectStreak + 1;
    const shouldPause =
      !pass &&
      nextRejectStreak >= config.audit.rejectStreakLimit &&
      ["active", "probation"].includes(executor.status);

    if (shouldPause) {
      assertTransition("agent", executor.status, "paused");
    }

    await db
      .update(agents)
      .set({
        successCount: executor.successCount + (pass ? 1 : 0),
        failCount: executor.failCount + (pass ? 0 : 1),
        trustScore: clamp(executor.trustScore + (pass ? 1 : -2)),
        rejectStreak: nextRejectStreak,
        ...(shouldPause ? { status: "paused" } : {}),
      })
      .where(eq(agents.id, executor.id));

    if (shouldPause) {
      await logAudit({
        userId: task.userId,
        actor: "system",
        action: "agent.paused",
        target: executor.id,
        before: {
          status: executor.status,
          rejectStreak: executor.rejectStreak,
        },
        after: {
          status: "paused",
          rejectStreak: nextRejectStreak,
          reason: "reject_streak_limit",
        },
      });
    }
  }

  if (pass && task.goalId) {
    const [goal] = await db.select().from(goals).where(eq(goals.id, task.goalId));
    if (goal) {
      await db
        .update(goals)
        .set({ progress: clamp(goal.progress + 2, 0, 100) })
        .where(eq(goals.id, goal.id));
    }
  }

  await logAudit({
    userId: task.userId,
    actor: `agent:${auditor.id}`,
    action: pass ? "audit.accept" : "audit.reject",
    target: taskId,
    before: { status: "auditing" },
    after: { status: nextStatus, reason },
  });

  return { decision: pass ? "accepted" : "rejected", reason, runId };
}
