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
import {
  auditVerdict,
  evaluateAcceptance,
  undeterminedCount,
  type AuditVerdict,
} from "@/lib/domain/acceptance";
import { isEligibleAuditSample } from "@/lib/domain/provenance";
import { recalculateGoalProgress } from "../progress";
import { recordMasteryOutcome } from "./mastery-outcome";
import { recordTaskLesson } from "../memory/task-lesson";
import { logEvent } from "@/lib/observability/log";
import type { Tx } from "@/server/services/shared/tx";
import { judgeSubmission, type JudgeFn } from "./judge";

export type AuditOptions = {
  /** 测试注入的判卷函数；生产路径下走 llm.judgeAnswer。 */
  judge?: JudgeFn;
};

type TaskRow = typeof tasks.$inferSelect;

/** 判卷是否发生、为什么没发生；写进审计行，事后能看出"判过了没通过"与"没判"的区别。 */
type JudgeTrace = {
  judgedBy: "model" | null;
  reason: string;
  model: string | null;
  score: number | null;
};

type PreJudgement = {
  artifactId: string;
  content: string;
  results: AcceptanceResult[];
  trace: JudgeTrace | null;
  /** 供应商回报的判卷用量；没回报时为 null。 */
  usage: { tokensIn: number; tokensOut: number } | null;
  /** 这次判卷请求的尝试 id；模型没被调用时为 null。 */
  attemptId: string | null;
};

/** 产物对应的证据 id；手交产物没有 run，也就没有检索发生过。 */
async function evidenceIdsFor(client: Tx | typeof db, runId: string | null) {
  if (!runId) return [];
  const rows = await client
    .select({ id: evidence.id })
    .from(evidence)
    .where(eq(evidence.runId, runId));
  return rows.map((row) => row.id);
}

function acceptanceContext(ids: string[], runId: string | null) {
  return {
    evidenceCount: ids.length,
    evidenceIds: new Set(ids),
    evidenceApplicable: Boolean(runId),
  };
}

/** 题面取标题 + 描述：判卷要判的是"回答了这道题"，不是"写了这段话"。 */
function judgeQuestion(task: TaskRow) {
  return task.description.trim()
    ? `${task.title}\n\n${task.description}`
    : task.title;
}

/**
 * 事务外先把判卷跑完。
 *
 * 判卷要调模型，超时上限 20 秒；放进审计事务里就等于把任务行锁 20 秒——
 * 这期间用户提交、取消、改派全都在排队等一个远程调用，而任务状态还停在
 * submitted，看起来像服务卡死。这里只读产物、算确定性判定、调一次模型，
 * 除了判卷自己的 learning_attempts（先落下来才说得清模型到底判了什么）
 * 不写任何业务行；事务里只比对"判的是不是当前这份产物"。
 */
async function prepareJudgement(input: {
  task: TaskRow;
  userId: string;
  options: AuditOptions;
}): Promise<PreJudgement | null> {
  const { task, userId, options } = input;
  if (!task.acceptanceChecklist?.length) return null;
  const [artifact] = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, task.id))
    .orderBy(desc(artifacts.createdAt))
    .limit(1);
  if (!artifact) return null;

  const ids = await evidenceIdsFor(db, artifact.runId);
  const judged = await judgeSubmission({
    userId,
    taskId: task.id,
    artifactId: artifact.id,
    question: judgeQuestion(task),
    answer: artifact.content,
    checklist: task.acceptanceChecklist,
    results: evaluateAcceptance(
      artifact.content,
      task.acceptanceChecklist,
      acceptanceContext(ids, artifact.runId),
    ),
    judge: options.judge,
  });

  return {
    artifactId: artifact.id,
    content: artifact.content,
    results: judged.results,
    trace:
      judged.reason === "no_judge_items"
        ? null
        : {
            judgedBy: judged.judged ? "model" : null,
            reason: judged.reason,
            model: judged.judgeModel ?? null,
            score: judged.score ?? null,
          },
    usage: judged.usage ?? null,
    attemptId: judged.attemptId ?? null,
  };
}

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

  const taskRuns = await db
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.createdAt));
  // 判卷在这里跑完，事务里只做比对（见 prepareJudgement 的注释）。
  const preJudge = await prepareJudgement({ task, userId, options });

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
    // 判卷调了模型，这条 run 就不是纯确定性的：`live` + 尝试 id 让页面按
    // 「真实模型」显示它，而不是在所有判过卷的审计上都印「演示模板」。
    const judgeAttempt = preJudge?.attemptId ?? null;
    await tx.insert(runs).values({
      id: runId,
      taskId,
      agentId: auditor.id,
      status: "running",
      mode: judgeAttempt ? "live" : "demo",
      providerAttemptId: judgeAttempt,
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

    // 三种结论而不是一个布尔：通过、被驳回、以及"根本没人给出结论"是三个不同的
    // 事实，落库时也走三条不同的边（accepted / rejected / needs_review）。
    let verdict: AuditVerdict = "fail";
    let reason = "没有找到可验收的产物。";
    let acceptanceReport: AcceptanceResult[] | null = null;
    // 判卷是否发生、为什么没发生，都要能从事后记录里读出来：
    // "判过了没通过"和"根本没判"在页面上长得一样，但在责任上完全不同。
    let judgeTrace: JudgeTrace | null = null;

    if (artifact && task.acceptanceChecklist?.length) {
      // Evidence is read from the run that produced the artifact, so a draft
      // cannot borrow citations from another run or invent them.
      const ids = await evidenceIdsFor(tx, artifact.runId);
      acceptanceReport = evaluateAcceptance(
        artifact.content,
        task.acceptanceChecklist,
        acceptanceContext(ids, artifact.runId),
      );
      // 判卷结论已经在事务外拿到。这里只认"判的就是现在这份产物"：读产物与
      // 拿到行锁之间有窗口（提交只允许从 planned/assigned/submitted/rejected
      // 发起），若恰好有人补交了一份，事务外那份判卷说的就是另一段内容，
      // 拿来给现在的产物下结论等于让报告描述一份没被判过的答案。
      const reusable =
        preJudge !== null &&
        preJudge.artifactId === artifact.id &&
        preJudge.content === artifact.content;
      if (reusable) {
        acceptanceReport = preJudge.results;
        judgeTrace = preJudge.trace;
      } else if (preJudge?.trace) {
        // 判过，但判的不是这份：结论一律不给，落回到"需要人判定"那一档，
        // 并如实记下为什么这份报告里没有判卷结论。
        judgeTrace = {
          judgedBy: null,
          reason: "artifact_changed",
          model: preJudge.trace.model,
          score: null,
        };
      }
      // 判卷必须在算 pass 之前：judge 项在确定性判定里一律是 undetermined，
      // 先算结论再回填会让报告写着"逐项通过"却挂着一条待判条目。
      verdict = auditVerdict(acceptanceReport);
      // 必须判定却没人判定的条目：needs_review 的理由就是它。
      const pendingRequiredItems = acceptanceReport.filter(
        (result) => result.item.required && result.undetermined,
      );
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
      reason =
        verdict === "pass"
          ? pending > 0
            ? `验收清单里能自动判定的条目全部通过；另有 ${pending} 项未判定（${pendingKinds.join("、")}），未计入本次结论。`
            : "验收清单逐项通过。"
          : verdict === "needs_review"
            ? // 这里不许出现"通过"二字：清单里躺着必须判定却没人判定的条目，
              // 除非把"没判"读成"过了"。结论只能停在待你判定。
              `验收清单没有结论：${pendingRequiredItems.length} 项必须判定的条目未判定（${pendingKinds.join("、")}），也没有明确的失败项。这不是通过，也不是驳回，等你判定。`
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
      // 空产物与明确缺失的评分标准是确定性结论（驳回）；其余情形里"逐条对照"
      // 根本没有发生过，那是没有结论——从前这里写成 accepted，等于把
      // "没人判过"升级成"验收通过"。
      if (!artifact.content.trim().length) {
        verdict = "fail";
        reason = "产物是空的，没有可验收的内容。";
      } else if (missingRubric) {
        verdict = "fail";
        reason = "缺少评分标准（rubric），无法判断题目质量。请补充后重新提交。";
      } else {
        verdict = "needs_review";
        reason =
          "产物已提交，但任务没有验收清单，没有人逐条对照过，所以验收没有结论。请你判定通过或驳回。";
      }
    }

    await addStep({
      type: "audit",
      input: {
        acceptanceCriteria: task.acceptanceCriteria,
        checklist: task.acceptanceChecklist ?? null,
      },
      output: { verdict, reason, checklist: acceptanceReport },
    });

    // 判卷那一步真的调了模型：它报告的 token 与费用记在这条审计 run 上。
    // 确定性核对（逐条对照证据、格式检查）本身不产生用量，所以没判卷时
    // 留 null 而不是 0——「没调用」与「调用过但没上报」不是同一个事实。
    const judgeUsage = preJudge?.usage ?? null;
    const judgeCost = judgeUsage
      ? Number(
          (
            ((judgeUsage.tokensIn + judgeUsage.tokensOut) / 1000) *
            config.cost.centsPer1kTokens
          ).toFixed(2),
        )
      : 0;

    await tx
      .update(runs)
      .set({
        status: "succeeded",
        endedAt: new Date(),
        costCents: judgeCost,
        tokensIn: judgeUsage?.tokensIn ?? null,
        tokensOut: judgeUsage?.tokensOut ?? null,
        // 调用过却没拿到用量（超时/供应商没报）记 unknown：那笔钱可能真的
        // 花掉了，写成 actual 0 就是替你保证没花钱。
        costSource: judgeUsage ? "actual" : judgeAttempt ? "unknown" : null,
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

    const nextStatus: "accepted" | "rejected" | "needs_review" =
      verdict === "pass" ? "accepted" : verdict === "fail" ? "rejected" : "needs_review";
    // 结论也是状态迁移：走同一张表，非法边在这里就炸，而不是写进一个状态机不认的状态。
    assertTransition("task", "auditing", nextStatus);
    const [decided] = await tx
      .update(tasks)
      .set({
        status: nextStatus,
        acceptanceReport,
        updatedAt: new Date(),
        ...(verdict === "pass"
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
        // needs_review 时保持 false：判卷行本来就写 false，待判不是"被接受"。
        .set({ accepted: verdict === "pass" })
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

    // 未判定条目的摘要同时供掌握度日志与审计行使用：审计行里只说"有一条没判"
    // 还不够，看不到是哪一条，就没法判断这条待判定值不值得自己接手。
    const pendingRequired = (acceptanceReport ?? []).filter(
      (entry) => entry.item.required && entry.undetermined,
    );

    // 掌握度是审计结论的派生数据；实现与用户亲手判定共用一处
    // （mastery-outcome.ts），否则两条链路迟早对"什么时候推进排期"给出不同答案。
    const mastery = await recordMasteryOutcome({
      tx,
      userId,
      task,
      verdict,
      source: "audit",
    });
    if (mastery === "skipped_undetermined") {
      logEvent("info", "mastery.undetermined_detail", {
        taskId,
        unjudged: pendingRequired.length,
      });
    }

    // 验收结论也要能被之后的检索找到：留下的是"什么算通过、为什么不通过"，
    // 而不是这次产物本身。needs_review 不写——没有结论时写一条"通过/驳回"
    // 的记忆就是替 Auditor 编了一个它没做出的判断；等用户判定时由
    // override.ts 补这一条。
    // 与掌握度同样放进 savepoint：验收已经确定，记忆写失败不该把它一起回滚。
    if (verdict !== "needs_review") {
      try {
        await tx.transaction(async (savepoint) => {
          await recordTaskLesson({
            userId,
            taskId,
            artifactId: artifact?.id ?? null,
            accepted: verdict === "pass",
            reason,
            tx: savepoint,
          });
        });
      } catch (error) {
        logEvent("error", "task_lesson.record_failed", {
          taskId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Only failures are mailed. A rejected task is the one thing the user must
    // look at today, and the mail must be enqueued in the same transaction so a
    // rollback cannot leave a promise in the outbox.
    if (verdict === "fail") {
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

    // 待判定不是失败，但它同样需要用户动手，而且不会自己变好：任务停在这个
    // 状态等一个人给出结论。只发驳回通知的版本里，用户永远收不到这封信。
    if (verdict === "needs_review") {
      await enqueueNotification(
        {
          userId,
          kind: "review",
          targetType: "task",
          targetId: taskId,
          ...notices.reviewNeeded({
            taskId,
            taskTitle: task.title,
            reason,
            pending: undeterminedCount(acceptanceReport ?? []),
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

    // needs_review 一律不写计数：成功和失败都是结论，没有人给出结论时
    // 两个方向都会失真——+1 会让 Agent 靠"未判定的产物"晋升，-2 会在
    // 没人判过的情况下扣信任分并推高连续驳回。
    if (executor && !userSubmitted && verdict !== "needs_review") {
      // Only real model execution counts as performance. A demo, rule-generated
      // or provider-less submission is still audited and recorded, but it must
      // not move the counters that unlock autonomy.
      // Eligibility belongs to the run that produced this artifact, not to the
      // newest run the Agent happens to have on the task. After a rejected draft
      // is re-run and the retry dies before reaching the provider, the newest run
      // has no provider attempt — reading that one would stop a genuinely live
      // submission from counting as the performance it was. A null link cannot be
      // attributed to any run, so it is not evidence of one.
      const producingRun =
        artifact?.runId == null
          ? undefined
          : taskRuns.find((run) => run.id === artifact.runId);
      const executorRun =
        producingRun?.agentId === executor.id ? producingRun : undefined;
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
                successCount: sql`${agents.successCount} + ${
                  verdict === "pass" ? 1 : 0
                }`,
                trustScore: sql`least(100, greatest(0, ${agents.trustScore} + ${
                  verdict === "pass" ? 1 : -2
                }))`,
              }
            : {}),
          failCount: sql`${agents.failCount} + ${verdict === "fail" ? 1 : 0}`,
          rejectStreak:
            verdict === "pass" ? 0 : sql`${agents.rejectStreak} + 1`,
        })
        .where(and(eq(agents.id, executor.id), eq(agents.userId, userId)))
        .returning();

      const shouldPause =
        verdict === "fail" &&
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

    if (verdict === "pass" && task.goalId) {
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

    // 待判定绝不能写成 audit.accept：审计日志是给人读的，那一行读起来就是
    // "验收通过"，而实际上没有人给出过结论。
    const auditAction =
      verdict === "pass"
        ? "audit.accept"
        : verdict === "fail"
          ? "audit.reject"
          : "audit.needs_review";

    await logAuditTx(tx, {
      userId,
      actor: `agent:${auditor.id}`,
      action: auditAction,
      target: taskId,
      before: { status: "auditing" },
      after: {
        status: nextStatus,
        // 三值结论留在审计行里：只看 status 时，"待你判定"与"通过"的区别
        // 还要再推一遍，事后核对报告的人未必知道状态机的细节。
        verdict,
        reason,
        // Which draft was judged. Without it a report could never be tied back
        // to the content it describes once a newer artifact exists.
        artifactId: artifact?.id ?? null,
        // 未判定条目的摘要：看审计行的人能知道"有一条没判"，但看不到是哪一条，
        // 也就没法判断这条待判定值不值得自己接手。
        ...(verdict === "needs_review"
          ? {
              pending: pendingRequired.map((entry) => ({
                type: entry.item.type,
                criterion:
                  entry.item.type === "manual"
                    ? entry.item.note
                    : entry.item.value,
                reason: entry.reason,
              })),
            }
          : {}),
        // 只有清单里真有 judge 项时才追加这个字段：没有判卷的任务，
        // 审计行必须与引入判卷之前逐字一致。
        ...(judgeTrace ? { judge: judgeTrace } : {}),
      },
    });

    return { runId, nextStatus, verdict, reason, pausedInfo };
  });

  return {
    /** 任务写回后的状态，调用方跟的字段。 */
    decision: result.nextStatus,
    /** 三值结论：pass / fail / needs_review，与 decision 一一对应。 */
    verdict: result.verdict,
    reason: result.reason,
    runId: result.runId,
  };
}
