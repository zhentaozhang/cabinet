import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, runs, skills, steps, tasks } from "@/lib/db/schema";
import { APPRENTICE_SKILL } from "@/contracts/templates";
import { logAudit } from "@/lib/audit";
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

export async function runApprenticeExam(userId: string) {
  const [apprentice] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.role, "apprentice")))
    .limit(1);
  if (!apprentice) {
    throw new NotFoundError("Apprentice not found");
  }

  if (!["shadowing", "drafting", "examining"].includes(apprentice.lifecycleStage)) {
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
  const examDraft = draftFor(
    "apprentice",
    skill?.name ?? "检索评估练习设计",
    0,
  );
  const examResults = evaluateAcceptance(examDraft.content, examChecklist);
  const required = examChecklist.length;
  const passed = examResults.filter((result) => result.passed).length;

  const examTaskId = `exam_${apprentice.id}`;
  const [existingExamTask] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, examTaskId))
    .limit(1);

  if (!existingExamTask) {
    await db.insert(tasks).values({
      id: examTaskId,
      userId: apprentice.userId,
      title: "学徒结业考试",
      description: "5 个留出任务，覆盖检索评估练习设计。",
      assigneeId: apprentice.id,
      auditorId: auditor.id,
      status: "done",
      priority: 2,
      acceptanceCriteria: "按技能 eval set 逐项验收；Auditor 监考。",
      acceptanceChecklist: examChecklist,
      acceptanceReport: examResults,
      estimateMin: 30,
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 0,
      createdBy: "system",
    });
  }

  if (apprentice.lifecycleStage === "shadowing") {
    assertTransition("apprentice", "shadowing", "drafting");
  }
  if (apprentice.lifecycleStage !== "examining") {
    assertTransition("apprentice", "drafting", "examining");
  }

  const runId = newId("run");
  await db.insert(runs).values({
    id: runId,
    taskId: examTaskId,
    agentId: apprentice.id,
    status: "succeeded",
    mode: "demo",
    startedAt: new Date(),
    endedAt: new Date(),
    costCents: 0.6,
    tokensIn: 400,
    tokensOut: 220,
    replayKey: "apprentice_exam_v1",
  });
  await db.insert(steps).values([
    {
      id: newId("stp"),
      runId,
      idx: 1,
      type: "tool",
      tool: "read_runs",
      input: { mentor: apprentice.mentorId ?? coach?.id ?? null, runs: 5 },
      output: { loaded: 5 },
      tokensIn: 200,
      tokensOut: 0,
      latencyMs: 120,
    },
    {
      id: newId("stp"),
      runId,
      idx: 2,
      type: "draft",
      input: { skill: skill?.name ?? "检索评估练习设计" },
      output: { rubric: true },
      tokensIn: 120,
      tokensOut: 160,
      latencyMs: 500,
    },
    {
      id: newId("stp"),
      runId,
      idx: 3,
      type: "audit",
      input: { heldOutTasks: required },
      output: { passed, required, results: examResults },
      tokensIn: 80,
      tokensOut: 60,
      latencyMs: 300,
    },
  ]);

  if (passed < required) {
    if (skill) {
      await db
        .update(skills)
        .set({
          eval: { status: "failed", required, passed, results: examResults },
        })
        .where(eq(skills.id, skill.id));
    }
    await logAudit({
      userId: apprentice.userId,
      actor: `agent:${auditor.id}`,
      action: "apprentice.exam_failed",
      target: apprentice.id,
      before: { stage: apprentice.lifecycleStage },
      after: { stage: apprentice.lifecycleStage, passed, required },
    });
    return { runId, passed, required, promoted: false };
  }

  const [promoted] = await db
    .update(agents)
    .set({
      lifecycleStage: "active",
      status: "active",
      trustScore: clamp(apprentice.trustScore + 10),
      successCount: apprentice.successCount + 1,
      autonomyLevel: 2,
      rejectStreak: 0,
    })
    .where(
      and(
        eq(agents.id, apprentice.id),
        inArray(agents.lifecycleStage, [
          "shadowing",
          "drafting",
          "examining",
        ]),
      ),
    )
    .returning();
  if (!promoted) throw new ConflictError("Apprentice was already promoted.");

  if (skill) {
    await db
      .update(skills)
      .set({
        status: "active",
        label: "production",
        successCount: 1,
        eval: { status: "passed", required, passed, results: examResults },
      })
      .where(
        and(eq(skills.id, skill.id), inArray(skills.status, ["draft", "exam"])),
      );
  }

  await logAudit({
    userId: apprentice.userId,
    actor: `agent:${auditor.id}`,
    action: "apprentice.promote",
    target: apprentice.id,
    before: { stage: apprentice.lifecycleStage },
    after: {
      stage: "active",
      exam: `${passed}/${required}`,
      skill: "active",
    },
  });

  return { runId, passed, required };
}
