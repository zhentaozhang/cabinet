import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  apprenticeExamSnapshots,
  apprenticeObservations,
  artifacts,
  runs,
  skills,
  steps,
  tasks,
} from "@/lib/db/schema";
import { APPRENTICE_SKILL } from "@/contracts/templates";
import { logAuditTx } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { evaluateAcceptance } from "@/lib/domain/acceptance";
import { assertTransition } from "@/lib/domain/state";
import {
  ConflictError,
  NotFoundError,
  PolicyDenied,
  ValidationError,
} from "@/lib/domain/errors";
import {
  eligibleMentorRuns,
  loadApprentice,
  loadObservations,
  readLatestSkill,
  resolveMentor,
  type ApprenticeshipEvidence,
  type ObservationCandidate,
} from "../queries/apprenticeship";
import { evaluateGraduation } from "../queries/autonomy";
import { draftFor } from "../shared/draft";
import { auditTask } from "./tasks/audit";

const EXAM_ATTEMPT_LIMIT = 2;
const EXAM_LIFECYCLE_STAGES = ["shadowing", "drafting", "examining"] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type { ApprenticeshipEvidence, ObservationCandidate };

export type RecordObservationResult = {
  id: string;
  runId: string;
  duplicate: boolean;
  observed: number;
};

/** The command-side skill row: created on demand so the exam always has a target. */
async function ensureApprenticeSkill(tx: Tx, apprenticeId: string) {
  const existing = await readLatestSkill(tx, apprenticeId);
  if (existing) return existing;

  await tx.insert(skills).values({
    id: newId("sk"),
    agentId: apprenticeId,
    name: APPRENTICE_SKILL.name,
    version: 1,
    steps: [...APPRENTICE_SKILL.steps],
    tools: [...APPRENTICE_SKILL.tools],
    status: "draft",
    label: "draft",
    evalSet: APPRENTICE_SKILL.evalSet.map((item) => ({ ...item })),
    successCount: 0,
    failCount: 0,
    eval: {
      status: "not_started",
      required: APPRENTICE_SKILL.evalSet.length,
      passed: 0,
    },
  });
  const created = await readLatestSkill(tx, apprenticeId);
  if (!created) {
    throw new ConflictError("Apprentice skill could not be created.");
  }
  return created;
}

export async function recordApprenticeObservation(
  userId: string,
  runId: string,
): Promise<RecordObservationResult> {
  return db.transaction(async (tx) => {
    const apprentice = await loadApprentice(userId, tx);
    if (
      apprentice.status === "retired" ||
      apprentice.lifecycleStage === "retired"
    ) {
      throw new ValidationError("已退休的学徒不能再记录观摩。");
    }
    const mentor = await resolveMentor(userId, apprentice.mentorId, tx);
    const skill = await ensureApprenticeSkill(tx, apprentice.id);
    const [candidate] = await eligibleMentorRuns(userId, mentor.id, tx, runId);
    if (!candidate) {
      throw new ValidationError(
        "这条运行不能作为观摩证据：需要 mentor 的真实模型运行，且任务已经验收通过。",
      );
    }

    const [inserted] = await tx
      .insert(apprenticeObservations)
      .values({
        id: newId("obs"),
        userId,
        apprenticeId: apprentice.id,
        mentorId: mentor.id,
        skillId: skill.id,
        skillVersion: skill.version,
        taskId: candidate.taskId,
        runId,
        artifactId: candidate.artifactId,
        attestedByUserId: userId,
        qualification: "qualified",
      })
      .onConflictDoNothing({
        target: [
          apprenticeObservations.apprenticeId,
          apprenticeObservations.skillId,
          apprenticeObservations.skillVersion,
          apprenticeObservations.runId,
        ],
      })
      .returning();

    const observations = await loadObservations(
      apprentice.id,
      skill.id,
      skill.version,
      tx,
    );

    if (!inserted) {
      const existing = observations.find((row) => row.runId === runId);
      if (!existing) {
        throw new ConflictError("观摩记录写入冲突，请重试。");
      }
      return {
        id: existing.id,
        runId,
        duplicate: true,
        observed: observations.length,
      };
    }

    await logAuditTx(tx, {
      userId,
      actor: `user:${userId}`,
      action: "apprentice.observation_recorded",
      target: apprentice.id,
      before: null,
      after: {
        runId,
        mentorId: mentor.id,
        skillId: skill.id,
        skillVersion: skill.version,
        observed: observations.length,
        required: APPRENTICE_SKILL.minShadowRuns,
      },
    });

    return {
      id: inserted.id,
      runId,
      duplicate: false,
      observed: observations.length,
    };
  });
}

export async function runApprenticeExam(userId: string) {
  const attempt = await db.transaction(async (tx) => {
    // One lock serialises both attempts and the stage checks that follow.
    const [apprentice] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.userId, userId), eq(agents.role, "apprentice")))
      .limit(1)
      .for("update");
    if (!apprentice) {
      throw new NotFoundError("Apprentice not found");
    }
    if (apprentice.status === "retired") {
      throw new ValidationError("Apprentice is retired and cannot take the exam.");
    }
    if (
      !EXAM_LIFECYCLE_STAGES.includes(
        apprentice.lifecycleStage as (typeof EXAM_LIFECYCLE_STAGES)[number],
      )
    ) {
      throw new ConflictError(
        `Apprentice is already ${apprentice.lifecycleStage}.`,
      );
    }

    const [auditor] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.userId, userId), eq(agents.role, "auditor")))
      .limit(1);
    if (!auditor) {
      throw new ValidationError("Auditor not found for this workspace.");
    }

    const mentor = await resolveMentor(userId, apprentice.mentorId, tx);
    const skill = await ensureApprenticeSkill(tx, apprentice.id);
    const observations = await loadObservations(
      apprentice.id,
      skill.id,
      skill.version,
      tx,
    );
    const requiredObservations = APPRENTICE_SKILL.minShadowRuns;
    if (observations.length < requiredObservations) {
      throw new ValidationError(
        `学徒需要先记录 ${requiredObservations} 条观摩证据才能参加考试；当前 ${observations.length} 条。`,
      );
    }

    const examChecklist =
      skill.evalSet && skill.evalSet.length > 0
        ? skill.evalSet
        : APPRENTICE_SKILL.evalSet.map((item) => ({ ...item }));
    if (examChecklist.length === 0) {
      throw new ValidationError("Skill has no eval set; cannot run the exam.");
    }

    const attemptNo =
      (
        await tx
          .select({ count: sql<number>`count(*)` })
          .from(apprenticeExamSnapshots)
          .where(
            and(
              eq(apprenticeExamSnapshots.apprenticeId, apprentice.id),
              eq(apprenticeExamSnapshots.skillId, skill.id),
              eq(apprenticeExamSnapshots.skillVersion, skill.version),
            ),
          )
      )[0]?.count ?? 0;
    const attemptCount = Number(attemptNo) + 1;

    // The exam artifact is a deterministic simulation, not a model-produced
    // piece of work. It is submitted and audited through the normal task path so
    // the acceptance report and audit chain are real even though the draft is
    // simulated.
    const examDraft = draftFor("apprentice", skill.name, 0);
    const examResults = evaluateAcceptance(examDraft.content, examChecklist);
    const required = examChecklist.length;
    const passed = examResults.filter((result) => result.passed).length;

    let nextStage = apprentice.lifecycleStage;
    if (nextStage === "shadowing") {
      assertTransition("apprentice", "shadowing", "drafting");
      nextStage = "drafting";
    }
    if (nextStage !== "examining") {
      assertTransition("apprentice", nextStage, "examining");
      nextStage = "examining";
    }

    const examTaskId =
      attemptCount === 1
        ? `exam_${apprentice.id}`
        : `exam_${apprentice.id}_${attemptCount}`;
    const runId = newId("run");
    const artifactId = newId("art");
    const snapshotId = newId("exs");

    await tx.insert(tasks).values({
      id: examTaskId,
      userId: apprentice.userId,
      title:
        attemptCount === 1
          ? "学徒结业考试"
          : `学徒结业考试（第 ${attemptCount} 次）`,
      description:
        "模拟留出考试：由确定性模板生成技能草案，覆盖技能 eval set；Auditor 通过常规审计流程验收。通过只代表练习完成，不代表转正。",
      assigneeId: apprentice.id,
      auditorId: auditor.id,
      status: "submitted",
      priority: 2,
      acceptanceCriteria: "按技能 eval set 逐项验收；Auditor 监考。",
      acceptanceChecklist: examChecklist,
      estimateMin: 30,
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 0,
      createdBy: "system",
    });

    await tx.insert(runs).values({
      id: runId,
      taskId: examTaskId,
      agentId: apprentice.id,
      status: "succeeded",
      mode: "demo",
      sourceType: "demo_fixture",
      startedAt: new Date(),
      endedAt: new Date(),
      // The deterministic exam template never touches a provider.
      costCents: 0,
      tokensIn: null,
      tokensOut: null,
      runLabel: `apprentice_exam_v1#${attemptCount}`,
    });
    await tx.insert(artifacts).values({
      id: artifactId,
      runId,
      taskId: examTaskId,
      type: "markdown",
      title: examDraft.title,
      content: examDraft.content,
      sourceType: "demo_fixture",
    });
    await tx.insert(steps).values([
      {
        id: newId("stp"),
        runId,
        idx: 1,
        type: "tool",
        tool: "read_runs",
        input: {
          mentor: mentor.id,
          observations: observations.length,
          required: requiredObservations,
        },
        output: { loaded: observations.length },
        tokensIn: 200,
        tokensOut: 0,
        latencyMs: 120,
      },
      {
        id: newId("stp"),
        runId,
        idx: 2,
        type: "draft",
        input: { skill: skill.name, simulated: true },
        output: { rubric: true, artifactId },
        tokensIn: 120,
        tokensOut: 160,
        latencyMs: 500,
      },
      {
        id: newId("stp"),
        runId,
        idx: 3,
        type: "audit",
        input: { heldOutTasks: required, attempt: attemptCount },
        output: { passed, required, results: examResults },
        tokensIn: 80,
        tokensOut: 60,
        latencyMs: 300,
      },
    ]);

    // The snapshot is written with the attempt so concurrent callers cannot both
    // claim the same evidence, and a retry reuses the same observations.
    await tx.insert(apprenticeExamSnapshots).values({
      id: snapshotId,
      userId,
      apprenticeId: apprentice.id,
      skillId: skill.id,
      skillVersion: skill.version,
      attemptNo: attemptCount,
      runId,
      observationIds: observations.map((row) => row.id),
      passed: false,
    });

    await tx
      .update(agents)
      .set({ lifecycleStage: nextStage })
      .where(
        and(
          eq(agents.id, apprentice.id),
          inArray(agents.lifecycleStage, [...EXAM_LIFECYCLE_STAGES]),
        ),
      );

    await logAuditTx(tx, {
      userId,
      actor: `agent:${apprentice.id}`,
      action: "task.submit",
      target: examTaskId,
      before: null,
      after: {
        status: "submitted",
        runId,
        artifactId,
        attempt: attemptCount,
        simulated: true,
        observations: observations.length,
      },
    });

    return {
      apprenticeId: apprentice.id,
      currentStage: apprentice.lifecycleStage,
      skillId: skill.id,
      skillVersion: skill.version,
      skillName: skill.name,
      snapshotId,
      observationIds: observations.map((row) => row.id),
      observed: observations.length,
      requiredObservations,
      attempt: attemptCount,
      examTaskId,
      runId,
      passed,
      required,
      examResults,
      failCount: skill.failCount,
    };
  });

  const audit = await auditTask(attempt.examTaskId, userId);
  const practicePassed = audit.decision === "accepted";

  const result = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(agents)
      .where(eq(agents.id, attempt.apprenticeId))
      .limit(1);
    if (!current) {
      throw new NotFoundError("Apprentice not found");
    }

    if (practicePassed) {
      assertTransition("apprentice", current.lifecycleStage, "practice_passed");
      const [passedAgent] = await tx
        .update(agents)
        .set({
          lifecycleStage: "practice_passed",
          rejectStreak: 0,
        })
        .where(
          and(
            eq(agents.id, attempt.apprenticeId),
            eq(agents.lifecycleStage, "examining"),
          ),
        )
        .returning();
      if (!passedAgent) {
        throw new ConflictError("Apprentice state changed; retry.");
      }

      // The exam is practice only: the skill stays a draft and the Agent keeps
      // its trust level and autonomy until a real evaluation exists.
      await tx
        .update(skills)
        .set({
          label: "practice",
          eval: {
            status: "practice_passed",
            required: attempt.required,
            passed: attempt.passed,
            results: attempt.examResults,
            attempt: attempt.attempt,
            taskId: attempt.examTaskId,
            observations: attempt.observationIds.length,
          },
        })
        .where(
          and(
            eq(skills.id, attempt.skillId),
            inArray(skills.status, ["draft", "exam"]),
          ),
        );

      await tx
        .update(apprenticeExamSnapshots)
        .set({ passed: true })
        .where(eq(apprenticeExamSnapshots.id, attempt.snapshotId));

      await logAuditTx(tx, {
        userId,
        actor: `agent:${attempt.apprenticeId}`,
        action: "apprentice.practice_passed",
        target: attempt.apprenticeId,
        before: { stage: current.lifecycleStage },
        after: {
          stage: "practice_passed",
          exam: `${attempt.passed}/${attempt.required}`,
          skill: "practice",
          observations: attempt.observationIds.length,
          taskId: attempt.examTaskId,
        },
      });

      return {
        promoted: false,
        practicePassed: true,
        retired: false,
        failedAttempts: attempt.failCount,
      };
    }

    const failedAttempts = attempt.failCount + 1;
    const retired = failedAttempts >= EXAM_ATTEMPT_LIMIT;
    await tx
      .update(skills)
      .set({
        failCount: failedAttempts,
        eval: {
          status: "failed",
          required: attempt.required,
          passed: attempt.passed,
          results: attempt.examResults,
          attempt: attempt.attempt,
          failedAttempts,
          taskId: attempt.examTaskId,
          observations: attempt.observationIds.length,
        },
      })
      .where(eq(skills.id, attempt.skillId));

    await logAuditTx(tx, {
      userId,
      actor: `agent:${attempt.apprenticeId}`,
      action: "apprentice.exam_failed",
      target: attempt.apprenticeId,
      before: { stage: current.lifecycleStage },
      after: {
        stage: retired ? "retired" : "drafting",
        passed: attempt.passed,
        required: attempt.required,
        attempt: attempt.attempt,
        failedAttempts,
        taskId: attempt.examTaskId,
      },
    });

    if (retired) {
      const retiredAt = new Date();
      assertTransition("apprentice", current.lifecycleStage, "retired");
      const [retiredAgent] = await tx
        .update(agents)
        .set({
          status: "retired",
          lifecycleStage: "retired",
          retiredAt,
        })
        .where(
          and(
            eq(agents.id, attempt.apprenticeId),
            inArray(agents.lifecycleStage, [...EXAM_LIFECYCLE_STAGES]),
          ),
        )
        .returning();
      if (!retiredAgent) {
        throw new ConflictError("Apprentice state changed; retry.");
      }
      await logAuditTx(tx, {
        userId,
        actor: "system",
        action: "apprentice.retired",
        target: attempt.apprenticeId,
        before: { stage: current.lifecycleStage, status: current.status },
        after: {
          stage: "retired",
          status: "retired",
          retiredAt: retiredAt.toISOString(),
          reason: "exam_failed_twice",
          failedAttempts,
        },
      });
      return {
        promoted: false,
        practicePassed: false,
        retired: true,
        failedAttempts,
      };
    }

    assertTransition("apprentice", current.lifecycleStage, "drafting");
    const [drafted] = await tx
      .update(agents)
      .set({ lifecycleStage: "drafting" })
      .where(
        and(
          eq(agents.id, attempt.apprenticeId),
          eq(agents.lifecycleStage, "examining"),
        ),
      )
      .returning();
    if (!drafted) {
      throw new ConflictError("Apprentice state changed; retry.");
    }

    return {
      promoted: false,
      practicePassed: false,
      retired: false,
      failedAttempts,
    };
  });

  return {
    runId: attempt.runId,
    passed: attempt.passed,
    required: attempt.required,
    observed: attempt.observed,
    requiredObservations: attempt.requiredObservations,
    ...result,
  };
}

export type GraduateResult = {
  graduated: boolean;
  reason: string;
  samples: number;
  passRate: number;
};

/**
 * 转正：把 `practice_passed` 的学徒提升为可接单的正式 Agent。
 *
 * The practice exam only proves the drill was completed (the UI says so since
 * the deterministic exam is a simulation), so graduation is judged on real
 * evidence instead — audited work that counts as actual model execution, plus
 * the trust/success floors. `evaluateGraduation` is the same authority the
 * Review page could read, and the write-back is conditional on the stage we
 * decided on, so two clicks can never graduate twice or resurrect a retired
 * apprentice.
 *
 * Before this existed, `practice_passed` had exactly one legal exit (retired)
 * and the `promoted` field on the exam result was hard-coded to false.
 */
export async function graduateApprentice(
  userId: string,
): Promise<GraduateResult> {
  return db.transaction(async (tx) => {
    const apprentice = await loadApprentice(userId, tx);
    if (apprentice.lifecycleStage === "active") {
      throw new ConflictError("学徒已经转正，无需重复操作。");
    }

    const decision = await evaluateGraduation(apprentice.id, userId, tx);
    if (!decision.allowed) {
      throw new PolicyDenied(`还不能转正：${decision.reason}`);
    }

    assertTransition("apprentice", apprentice.lifecycleStage, "active");

    const [graduated] = await tx
      .update(agents)
      .set({ lifecycleStage: "active", status: "active", rejectStreak: 0 })
      .where(
        and(
          eq(agents.id, apprentice.id),
          eq(agents.lifecycleStage, "practice_passed"),
        ),
      )
      .returning();
    if (!graduated) {
      throw new ConflictError("Apprentice state changed; retry.");
    }

    // v1 goes live only now. The practice pass deliberately left the skill as a
    // draft; an on-duty Agent whose skill is still a draft would take work with
    // no plan to run.
    await tx
      .update(skills)
      .set({ status: "active", label: "v1" })
      .where(
        and(
          eq(skills.agentId, apprentice.id),
          inArray(skills.status, ["draft", "exam"]),
        ),
      );

    await logAuditTx(tx, {
      userId,
      actor: "system",
      action: "apprentice.graduated",
      target: apprentice.id,
      before: {
        stage: apprentice.lifecycleStage,
        status: apprentice.status,
        autonomyLevel: apprentice.autonomyLevel,
        trustScore: apprentice.trustScore,
      },
      after: {
        stage: "active",
        status: "active",
        skill: "v1",
        samples: decision.samples,
        passRate: decision.passRate,
        reason: decision.reason,
      },
    });

    return {
      graduated: true,
      reason: decision.reason,
      samples: decision.samples,
      passRate: decision.passRate,
    };
  });
}
