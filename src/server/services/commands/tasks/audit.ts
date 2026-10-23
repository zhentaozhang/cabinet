import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { AcceptanceResult } from "@/lib/db/schema";
import {
  agents,
  artifacts,
  evidence,
  runs,
  steps,
  tasks,
} from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { getPolicyConfig } from "@/lib/policy/config";
import { decideAudit } from "@/lib/domain/policy";
import { enqueueNotification, notices } from "../notify";
import { assertTransition } from "@/lib/domain/state";
import {
  ConflictError,
  NotFoundError,
  PolicyDenied,
} from "@/lib/domain/errors";
import { checklistPassed, evaluateAcceptance, undeterminedCount } from "@/lib/domain/acceptance";
import { isEligibleAuditSample } from "@/lib/domain/provenance";
import { recalculateGoalProgress } from "../progress";

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
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
  if (!task) throw new NotFoundError("Task not found");
  if (!task.auditorId) throw new ConflictError("Task has no auditor");
  const [auditor] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, task.auditorId), eq(agents.userId, userId)));
  if (!auditor) throw new NotFoundError("Auditor not found");

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

  const userSubmitted = artifact?.submittedBy === "user";

  const result = await db.transaction(async (tx) => {
    const [locked] = await tx
      .update(tasks)
      .set({ status: "auditing", updatedAt: new Date() })
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.userId, userId),
          eq(tasks.status, "submitted"),
        ),
      )
      .returning();
    if (!locked) throw new ConflictError("Task is not submitted for audit.");

    const runId = newId("run");
    await tx.insert(runs).values({
      id: runId,
      taskId,
      agentId: auditor.id,
      status: "running",
      mode: "demo",
      sourceType: "system_event",
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
      await tx.insert(steps).values({
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
      // Evidence is read from the run that produced the artifact, so a draft
      // cannot borrow citations from another run or invent them.
      const evidenceRows = artifact.runId
        ? await tx
            .select({ id: evidence.id })
            .from(evidence)
            .where(eq(evidence.runId, artifact.runId))
        : [];
      acceptanceReport = evaluateAcceptance(
        artifact.content,
        task.acceptanceChecklist,
        {
          evidenceCount: evidenceRows.length,
          evidenceIds: new Set(evidenceRows.map((row) => row.id)),
          // A hand-submitted artifact has no run, so no retrieval happened.
          evidenceApplicable: Boolean(artifact.runId),
        },
      );
      pass = checklistPassed(acceptanceReport);
      const failed = acceptanceReport.filter(
        (result) => result.item.required && !result.passed && !result.undetermined,
      );
      const pending = undeterminedCount(acceptanceReport);
      const pendingNote =
        pending > 0 ? `另有 ${pending} 项需要你人工复核。` : "";
      reason = pass
        ? `验收清单逐项通过。${pendingNote}`
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

    await tx
      .update(runs)
      .set({
        status: "succeeded",
        endedAt: new Date(),
        // The auditor is deterministic: no provider was involved, so this run
        // carries no measured usage and no model cost.
        costCents: 0,
        tokensIn: null,
        tokensOut: null,
      })
      .where(eq(runs.id, runId));

    const [executor] = task.assigneeId
      ? await tx
          .select()
          .from(agents)
          .where(
            and(
              eq(agents.id, task.assigneeId),
              eq(agents.userId, userId),
            ),
          )
          .limit(1)
      : [];

    const nextStatus = pass ? "accepted" : "rejected";
    const [decided] = await tx
      .update(tasks)
      .set({
        status: nextStatus,
        acceptanceReport,
        updatedAt: new Date(),
        ...(pass
          ? {
              acceptedAt: new Date(),
              acceptedAutonomyLevel: userSubmitted
                ? null
                : (executor?.autonomyLevel ?? null),
            }
          : {}),
      })
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.userId, userId),
          eq(tasks.status, "auditing"),
        ),
      )
      .returning();
    if (!decided) throw new ConflictError("Task left the auditing state.");

    // Only failures are mailed. A rejected task is the one thing the user must
    // look at today, and the mail must be enqueued in the same transaction so a
    // rollback cannot leave a promise in the outbox.
    if (!pass) {
      await enqueueNotification(
        {
          userId,
          kind: "rejection",
          targetType: "task",
          targetId: taskId,
          ...notices.rejection({
            taskId,
            taskTitle: task.title,
            reason,
          }),
        },
        tx,
      );
    }

    let pausedInfo:
      | {
          executorId: string;
          before: { status: string; rejectStreak: number };
          after: { status: string; rejectStreak: number };
        }
      | null = null;

    if (executor && !userSubmitted) {
      // Only real model execution counts as performance. A demo, rule-generated
      // or provider-less submission is still audited and recorded, but it must
      // not move the counters that unlock autonomy.
      const executorRun = taskRuns.find(
        (run) => run.agentId === executor.id,
      );
      const countsAsEvidence =
        artifact !== undefined &&
        executorRun !== undefined &&
        isEligibleAuditSample({
          artifactSubmittedBy: artifact.submittedBy,
          artifactSourceType: artifact.sourceType,
          executionChannel: executorRun.mode,
          hasProviderAttempt: executorRun.providerAttemptId !== null,
        });

      // Increment in SQL, not from the row read before the lock: two audits of
      // the same Agent would otherwise write the same stale values and one
      // result would be lost. `returning()` gives the post-increment streak the
      // pause decision needs.
      const [afterCounters] = await tx
        .update(agents)
        .set({
          ...(countsAsEvidence
            ? {
                successCount: sql`${agents.successCount} + ${pass ? 1 : 0}`,
                trustScore: sql`least(100, greatest(0, ${agents.trustScore} + ${
                  pass ? 1 : -2
                }))`,
              }
            : {}),
          failCount: sql`${agents.failCount} + ${pass ? 0 : 1}`,
          rejectStreak: pass ? 0 : sql`${agents.rejectStreak} + 1`,
        })
        .where(and(eq(agents.id, executor.id), eq(agents.userId, userId)))
        .returning();

      const shouldPause =
        !pass &&
        afterCounters !== undefined &&
        afterCounters.rejectStreak >= config.audit.rejectStreakLimit &&
        ["active", "probation"].includes(afterCounters.status);

      if (shouldPause) {
        assertTransition("agent", afterCounters.status, "paused");
        const [paused] = await tx
          .update(agents)
          .set({ status: "paused" })
          .where(
            and(
              eq(agents.id, executor.id),
              eq(agents.status, afterCounters.status),
            ),
          )
          .returning();
        if (paused) {
          pausedInfo = {
            executorId: executor.id,
            before: {
              status: afterCounters.status,
              rejectStreak: afterCounters.rejectStreak,
            },
            after: { status: "paused", rejectStreak: paused.rejectStreak },
          };
        }
      }
    }

    if (pass && task.goalId) {
      await recalculateGoalProgress(
        tx,
        userId,
        task.goalId,
        config.learning,
      );
    }

    if (pausedInfo) {
      await logAuditTx(tx, {
        userId,
        actor: "system",
        action: "agent.paused",
        target: pausedInfo.executorId,
        before: pausedInfo.before,
        after: { ...pausedInfo.after, reason: "reject_streak_limit" },
      });
    }

    await logAuditTx(tx, {
      userId,
      actor: `agent:${auditor.id}`,
      action:
        nextStatus === "accepted" ? "audit.accept" : "audit.reject",
      target: taskId,
      before: { status: "auditing" },
      after: { status: nextStatus, reason },
    });

    return { runId, nextStatus, reason, pausedInfo };
  });

  return {
    decision: result.nextStatus,
    reason: result.reason,
    runId: result.runId,
  };
}
