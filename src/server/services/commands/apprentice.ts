import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, runs, skills, steps, tasks } from "@/lib/db/schema";
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
    .where(eq(agents.id, "ag_apprentice"));
  if (!apprentice || apprentice.userId !== userId) {
    throw new NotFoundError("Apprentice not found");
  }

  if (!["shadowing", "drafting", "examining"].includes(apprentice.lifecycleStage)) {
    throw new ConflictError(
      `Apprentice is already ${apprentice.lifecycleStage}.`,
    );
  }

  const [skill] = await db
    .select()
    .from(skills)
    .where(eq(skills.agentId, "ag_apprentice"))
    .orderBy(desc(skills.createdAt))
    .limit(1);

  const examChecklist = skill?.evalSet ?? [];
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
      auditorId: "ag_auditor",
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
    agentId: "ag_apprentice",
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
      input: { mentor: apprentice.mentorId ?? "ag_coach", runs: 5 },
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
      actor: "agent:ag_auditor",
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
    actor: "agent:ag_auditor",
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
