import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, artifacts, runs, skills, steps, tasks } from "@/lib/db/schema";
import { APPRENTICE_SKILL } from "@/contracts/templates";
import { logAuditTx } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { evaluateAcceptance } from "@/lib/domain/acceptance";
import { assertTransition } from "@/lib/domain/state";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/lib/domain/errors";
import { clamp } from "../shared/numbers";
import { draftFor } from "../shared/draft";
import { auditTask } from "./tasks/audit";

const EXAM_ATTEMPT_LIMIT = 2;
const EXAM_LIFECYCLE_STAGES = ["shadowing", "drafting", "examining"] as const;

export async function runApprenticeExam(userId: string) {
  const [apprentice] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.role, "apprentice")))
    .limit(1);
  if (!apprentice) {
    throw new NotFoundError("Apprentice not found");
  }

  if (apprentice.status === "retired") {
    throw new ValidationError("Apprentice is retired and cannot take the exam.");
  }

  if (!EXAM_LIFECYCLE_STAGES.includes(apprentice.lifecycleStage as (typeof EXAM_LIFECYCLE_STAGES)[number])) {
    throw new ConflictError(
      `Apprentice is already ${apprentice.lifecycleStage}.`,
    );
  }

  const [auditor] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.role, "auditor")))
    .limit(1);
  if (!auditor) {
    throw new ValidationError("Auditor not found for this workspace.");
  }

  const [coach] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.role, "coach")))
    .limit(1);

  const mentorId = apprentice.mentorId ?? coach?.id ?? null;
  const observerIds = mentorId ? [apprentice.id, mentorId] : [apprentice.id];
  const [shadowRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(runs)
    .where(
      and(
        inArray(runs.agentId, observerIds),
        eq(runs.status, "succeeded"),
      ),
    );
  const shadowRuns = Number(shadowRow?.count ?? 0);
  if (shadowRuns < APPRENTICE_SKILL.minShadowRuns) {
    throw new ValidationError(
      `Apprentice needs ${APPRENTICE_SKILL.minShadowRuns} successful mentor/apprentice runs before the exam; found ${shadowRuns}.`,
    );
  }

  let [skill] = await db
    .select()
    .from(skills)
    .where(eq(skills.agentId, apprentice.id))
    .orderBy(desc(skills.createdAt))
    .limit(1);

  if (!skill) {
    await db.insert(skills).values({
      id: newId("sk"),
      agentId: apprentice.id,
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
    [skill] = await db
      .select()
      .from(skills)
      .where(eq(skills.agentId, apprentice.id))
      .orderBy(desc(skills.createdAt))
      .limit(1);
  }

  const examChecklist =
    skill?.evalSet && skill.evalSet.length > 0
      ? skill.evalSet
      : APPRENTICE_SKILL.evalSet.map((item) => ({ ...item }));
  if (examChecklist.length === 0) {
    throw new ValidationError("Skill has no eval set; cannot run the exam.");
  }

  // The exam artifact is a deterministic simulation, not a model-produced
  // piece of work. It is submitted and audited through the normal task path so
  // the acceptance report and audit chain are real even though the draft is
  // simulated.
  const attempt = (skill?.failCount ?? 0) + 1;
  const examDraft = draftFor(
    "apprentice",
    skill?.name ?? APPRENTICE_SKILL.name,
    0,
  );
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
    attempt === 1 ? `exam_${apprentice.id}` : `exam_${apprentice.id}_${attempt}`;
  const runId = newId("run");
  const artifactId = newId("art");

  await db.transaction(async (tx) => {
    await tx.insert(tasks).values({
      id: examTaskId,
      userId: apprentice.userId,
      title: attempt === 1 ? "学徒结业考试" : `学徒结业考试（第 ${attempt} 次）`,
      description:
        "模拟留出考试：由确定性模板生成技能草案，覆盖技能 eval set；Auditor 通过常规审计流程验收。",
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
      costCents: 0.6,
      tokensIn: 400,
      tokensOut: 220,
      replayKey: `apprentice_exam_v1#${attempt}`,
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
          mentor: mentorId,
          runs: shadowRuns,
          minShadowRuns: APPRENTICE_SKILL.minShadowRuns,
        },
        output: { loaded: Math.min(shadowRuns, APPRENTICE_SKILL.minShadowRuns) },
        tokensIn: 200,
        tokensOut: 0,
        latencyMs: 120,
      },
      {
        id: newId("stp"),
        runId,
        idx: 2,
        type: "draft",
        input: { skill: skill?.name ?? APPRENTICE_SKILL.name, simulated: true },
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
        input: { heldOutTasks: required, attempt },
        output: { passed, required, results: examResults },
        tokensIn: 80,
        tokensOut: 60,
        latencyMs: 300,
      },
    ]);

    await tx
      .update(agents)
      .set({ lifecycleStage: "examining" })
      .where(
        and(
          eq(agents.id, apprentice.id),
          inArray(agents.lifecycleStage, [...EXAM_LIFECYCLE_STAGES]),
        ),
      );

    await logAuditTx(tx, {
      userId: apprentice.userId,
      actor: `agent:${apprentice.id}`,
      action: "task.submit",
      target: examTaskId,
      before: null,
      after: {
        status: "submitted",
        runId,
        artifactId,
        attempt,
        simulated: true,
      },
    });
  });

  const audit = await auditTask(examTaskId, userId);
  const promoted = audit.decision === "accepted";

  const result = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(agents)
      .where(eq(agents.id, apprentice.id))
      .limit(1);
    if (!current) {
      throw new NotFoundError("Apprentice not found");
    }

    if (promoted) {
      const [promotedAgent] = await tx
        .update(agents)
        .set({
          lifecycleStage: "active",
          status: "active",
          trustScore: clamp(current.trustScore + 10),
          autonomyLevel: 2,
          rejectStreak: 0,
        })
        .where(
          and(
            eq(agents.id, apprentice.id),
            inArray(agents.lifecycleStage, [...EXAM_LIFECYCLE_STAGES]),
          ),
        )
        .returning();
      if (!promotedAgent) {
        throw new ConflictError("Apprentice was already promoted.");
      }

      if (skill) {
        await tx
          .update(skills)
          .set({
            status: "active",
            label: "production",
            successCount: 1,
            eval: {
              status: "passed",
              required,
              passed,
              results: examResults,
              attempt,
              taskId: examTaskId,
            },
          })
          .where(
            and(
              eq(skills.id, skill.id),
              inArray(skills.status, ["draft", "exam"]),
            ),
          );
      }

      await logAuditTx(tx, {
        userId: apprentice.userId,
        actor: `agent:${auditor.id}`,
        action: "apprentice.promote",
        target: apprentice.id,
        before: { stage: current.lifecycleStage },
        after: {
          stage: "active",
          exam: `${passed}/${required}`,
          skill: "active",
          taskId: examTaskId,
        },
      });
      return { promoted: true, retired: false, failedAttempts: skill?.failCount ?? 0 };
    }

    const failedAttempts = (skill?.failCount ?? 0) + 1;
    const retired = failedAttempts >= EXAM_ATTEMPT_LIMIT;
    if (skill) {
      await tx
        .update(skills)
        .set({
          failCount: failedAttempts,
          eval: {
            status: "failed",
            required,
            passed,
            results: examResults,
            attempt,
            failedAttempts,
            taskId: examTaskId,
          },
        })
        .where(eq(skills.id, skill.id));
    }

    await logAuditTx(tx, {
      userId: apprentice.userId,
      actor: `agent:${auditor.id}`,
      action: "apprentice.exam_failed",
      target: apprentice.id,
      before: { stage: current.lifecycleStage },
      after: {
        stage: retired ? "retired" : "drafting",
        passed,
        required,
        attempt,
        failedAttempts,
        taskId: examTaskId,
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
            eq(agents.id, apprentice.id),
            inArray(agents.lifecycleStage, [...EXAM_LIFECYCLE_STAGES]),
          ),
        )
        .returning();
      if (!retiredAgent) {
        throw new ConflictError("Apprentice state changed; retry.");
      }
      await logAuditTx(tx, {
        userId: apprentice.userId,
        actor: "system",
        action: "apprentice.retired",
        target: apprentice.id,
        before: { stage: current.lifecycleStage, status: current.status },
        after: {
          stage: "retired",
          status: "retired",
          retiredAt: retiredAt.toISOString(),
          reason: "exam_failed_twice",
          failedAttempts,
        },
      });
      return { promoted: false, retired: true, failedAttempts };
    }

    assertTransition("apprentice", current.lifecycleStage, "drafting");
    const [drafted] = await tx
      .update(agents)
      .set({ lifecycleStage: "drafting" })
      .where(
        and(
          eq(agents.id, apprentice.id),
          eq(agents.lifecycleStage, "examining"),
        ),
      )
      .returning();
    if (!drafted) {
      throw new ConflictError("Apprentice state changed; retry.");
    }

    return { promoted: false, retired: false, failedAttempts };
  });

  return { runId, passed, required, ...result };
}
