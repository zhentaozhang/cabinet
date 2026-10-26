import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { AcceptanceResult } from "@/lib/db/schema";
import {
  agents,
  artifacts,
  evidence,
  learningAttempts,
  runs,
  steps,
  tasks,
} from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { getPolicyConfigFor } from "@/lib/policy/config";
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
import { recordOutcome } from "../learning/mastery";
import { logEvent } from "@/lib/observability/log";
import { judgeSubmission, type JudgeFn } from "./judge";

export type AuditOptions = {
  /** 测试注入的判卷函数；生产路径下走 llm.judgeAnswer。 */
  judge?: JudgeFn;
};

export async function auditTask(
  taskId: string,
  userId: string,
  options: AuditOptions = {},
) {
  try {
    return await auditTaskInner(taskId, userId, options);
  } catch (error) {
    await db
      .update(tasks)
      .set({ status: "submitted", updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "auditing")));
    throw error;
  }
}

async function auditTaskInner(
  taskId: string,
  userId: string,
  options: AuditOptions,
) {
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

  // 用户级配置：audit.rejectStreakLimit 是白名单里可被洞察调整的键，
  // 用全局缓存会让那条覆盖永远不生效。
  const config = await getPolicyConfigFor(userId);
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

  // 只有学习模板的验收才推进掌握度：其余任务即便手写了 topicKey 也与复习无关。
  const isLearningTask =
    task.template === "learning" || task.template === "learning_retest";

  const taskRuns = await db
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.createdAt));
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

    // Read the artifact after the status lock, not before it. Submitting is
    // only allowed from planned/assigned/submitted/rejected, so once the row is
    // `auditing` no new artifact can appear — the content judged below is the
    // content recorded in the report. Reading it before the lock left a window
    // where a concurrent submission swapped the draft mid-audit.
    const [artifact] = await tx
      .select()
      .from(artifacts)
      .where(eq(artifacts.taskId, taskId))
      .orderBy(desc(artifacts.createdAt))
      .limit(1);
    const userSubmitted = artifact?.submittedBy === "user";

    const runId = newId("run");
    await tx.insert(runs).values({
      id: runId,
      taskId,
      agentId: auditor.id,
      status: "running",
      mode: "demo",
      sourceType: "system_event",
      startedAt: new Date(),
      runLabel: `audit_${taskId}_${taskRuns.length + 1}`,
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
    let reason = "没有找到可验收的产物。";
    let acceptanceReport: AcceptanceResult[] | null = null;
    // 判卷是否发生、为什么没发生，都要能从事后记录里读出来：
    // "判过了没通过"和"根本没判"在页面上长得一样，但在责任上完全不同。
    let judgeTrace: {
      judgedBy: "model" | null;
      reason: string;
      model: string | null;
      score: number | null;
    } | null = null;

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
      // 判卷必须在算 pass 之前：judge 项在确定性判定里一律是 undetermined，
      // 先算结论再回填会让报告写着"逐项通过"却挂着一条待判条目。
      const judged = await judgeSubmission({
        userId,
        taskId,
        artifactId: artifact.id,
        // 题面取标题 + 描述：判卷要判的是"回答了这道题"，不是"写了这段话"。
        question: task.description.trim()
          ? `${task.title}\n\n${task.description}`
          : task.title,
        answer: artifact.content,
        checklist: task.acceptanceChecklist,
        results: acceptanceReport,
        tx,
        judge: options.judge,
      });
      acceptanceReport = judged.results;
      if (judged.reason !== "no_judge_items") {
        judgeTrace = {
          judgedBy: judged.judged ? "model" : null,
          reason: judged.reason,
          model: judged.judgeModel ?? null,
          score: judged.score ?? null,
        };
      }

      pass = checklistPassed(acceptanceReport);
      const failed = acceptanceReport.filter(
        (result) => result.item.required && !result.passed && !result.undetermined,
      );
      const pending = undeterminedCount(acceptanceReport);
      // 未判定的条目（manual、判卷未出结论）不阻塞验收，但也不能让报告替它们
      // 结论。这里按类型分开说，因为"等你人工判"和"模型没判"是两件事：
      // 前者用户看得懂，后者是配置或调用出了状况。之前无论哪种都只写
      // "逐项通过"，判卷从来没跑过也照样成立，这句话在审计里不成立。
      const pendingKinds = Array.from(
        new Set(
          acceptanceReport
            .filter((result) => result.undetermined)
            .map((result) =>
              result.item.type === "judge" ? "模型判卷" : "人工判定",
            ),
        ),
      );
      reason = pass
        ? pending > 0
          ? `验收清单里能自动判定的条目全部通过；另有 ${pending} 项未判定（${pendingKinds.join("、")}），未计入本次结论。`
          : "验收清单逐项通过。"
        : `验收清单未通过：${failed
            .map((result) => result.reason)
            .join("；")}`;
    } else if (artifact) {
      // No checklist: the criteria are prose, so nothing was compared line by
      // line. This branch used to report "验收标准逐条对照通过" while comparing
      // nothing at all, and the page showed that sentence to the user.
      const requiresRubric =
        task.acceptanceCriteria.includes("评分标准") ||
        task.acceptanceCriteria.toLowerCase().includes("rubric");
      const hasRubric =
        artifact.content.includes("## 评分标准") ||
        artifact.content.includes("| 维度 |");
      const missingRubric = requiresRubric && !hasRubric;

      acceptanceReport = [
        {
          item: {
            type: "manual",
            note: task.acceptanceCriteria.trim() || task.title,
            required: true,
          },
          passed: false,
          undetermined: true,
          reason:
            "本任务没有验收清单，Auditor 只确认了产物存在；「逐条对照」没有发生，需要你人工判定",
        },
      ];
      pass = artifact.content.trim().length > 0 && !missingRubric;
      reason = missingRubric
        ? "缺少评分标准（rubric），无法判断题目质量。请补充后重新提交。"
        : pass
          ? "产物已提交；任务没有验收清单，验收没有逐条对照，结论待你确认。"
          : "产物是空的，没有可验收的内容。";
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

    // 判卷只写结论，accepted 由这里按整张清单的最终结论回填：
    // 学习历史里的"这份答案被接受了吗"必须与任务结论一致，否则两处说法打架。
    if (judgeTrace?.judgedBy === "model") {
      const settled = await tx
        .update(learningAttempts)
        .set({ accepted: pass })
        .where(
          and(
            eq(learningAttempts.userId, userId),
            eq(learningAttempts.taskId, taskId),
          ),
        )
        .returning({ id: learningAttempts.id });
      // 判卷行刚在本事务里写过，读不到说明数据被动过；静默通过会让
      // learning_attempts 永远停在 accepted=false，事后无法回溯。
      if (settled.length === 0) {
        throw new ConflictError("Judged attempt disappeared before acceptance.");
      }
    }

    // 掌握度是审计结论的派生数据，写在这里的 savepoint 里：验收已经确定，
    // 掌握度写失败只回滚这一小段，不会因为排期出错而丢掉一条有效验收；
    // 反过来把它留在事务外（旧写法），一旦这里报错就再没有任何东西会补上
    // 这一次复习——验收提交了、掌握度却没发生，且无法事后发现。
    // 只认带 topicKey 的学习任务模板：其余任务就算有人手写了 topicKey，
    // 也不该往掌握度表里灌一条没有教学意义的记录。
    const unjudgedRequired = (acceptanceReport ?? []).reduce(
      (acc, entry) => {
        if (entry.item.required && entry.undetermined) {
          if (entry.item.type === "judge") acc.judge += 1;
          else acc.other += 1;
        }
        return acc;
      },
      { judge: 0, other: 0 },
    );
    if (isLearningTask && task.topicKey) {
      // 有待判的判卷项时既不加也不减：没有结论≠答错，记成错答会把复习间隔
      // 压回一天，比不记更失真。
      if (unjudgedRequired.judge > 0) {
        logEvent("info", "mastery.skipped_unjudged", {
          taskId,
          topicKey: task.topicKey,
          unjudged: unjudgedRequired.judge,
        });
      } else {
        try {
          await tx.transaction(async (savepoint) => {
            await recordOutcome({
              userId,
              topicKey: task.topicKey as string,
              goalId: task.goalId,
              correct: nextStatus === "accepted",
              tx: savepoint,
            });
          });
        } catch (error) {
          // 走到这里说明 savepoint 已回滚，验收本身仍然成立。
          logEvent("error", "mastery.record_failed", {
            taskId,
            topicKey: task.topicKey,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

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
      after: {
        status: nextStatus,
        reason,
        // Which draft was judged. Without it a report could never be tied back
        // to the content it describes once a newer artifact exists.
        artifactId: artifact?.id ?? null,
        // 只有清单里真有 judge 项时才追加这个字段：没有判卷的任务，
        // 审计行必须与引入判卷之前逐字一致。
        ...(judgeTrace ? { judge: judgeTrace } : {}),
      },
    });

    return { runId, nextStatus, reason, pausedInfo };
  });

  return {
    decision: result.nextStatus,
    reason: result.reason,
    runId: result.runId,
  };
}
