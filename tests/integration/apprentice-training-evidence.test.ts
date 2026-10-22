import { DEMO_USER_ID } from "@/lib/demo";
import { beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  apprenticeExamSnapshots,
  apprenticeObservations,
  artifacts,
  auditEvents,
  runs,
  skills,
  tasks,
} from "@/lib/db/schema";
import {
  loadApprenticeshipEvidence,
  recordApprenticeObservation,
  runApprenticeExam,
} from "@/lib/engine";
import { APPRENTICE_SKILL } from "@/contracts/templates";
import { ConflictError, ValidationError } from "@/lib/domain/errors";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

async function agentByRole(role: string) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, DEMO_USER_ID), eq(agents.role, role)))
    .limit(1);
  return agent;
}

type SeedRunInput = {
  id: string;
  mentorId: string;
  taskStatus?: string;
  runStatus?: string;
  mode?: string;
  providerAttemptId?: string | null;
  artifactSource?: string;
  artifactSubmittedBy?: string;
};

/**
 * Seeds one mentor run with its task and artifact. Defaults describe a run that
 * qualifies; each test overrides exactly one dimension to prove the gate.
 */
async function seedMentorRun(input: SeedRunInput): Promise<void> {
  const {
    id,
    mentorId,
    taskStatus = "accepted",
    runStatus = "succeeded",
    mode = "live",
    providerAttemptId = `att_${id}`,
    artifactSource = "model_generated",
    artifactSubmittedBy = "agent",
  } = input;
  const taskId = `tsk_${id}`;
  await db.insert(tasks).values({
    id: taskId,
    userId: DEMO_USER_ID,
    title: `Mentor run ${id}`,
    description: "Mentor work the apprentice could observe.",
    assigneeId: mentorId,
    status: taskStatus,
    acceptanceCriteria: "可验收的 mentor 产出。",
    estimateMin: 10,
    actionType: "internal",
    resource: "task",
  });
  await db.insert(runs).values({
    id,
    taskId,
    agentId: mentorId,
    status: runStatus,
    mode,
    providerAttemptId,
    sourceType: "system_event",
    startedAt: new Date(),
    endedAt: new Date(),
  });
  await db.insert(artifacts).values({
    id: `art_${id}`,
    runId: id,
    taskId,
    type: "markdown",
    title: `Mentor artifact ${id}`,
    content: "mentor output",
    submittedBy: artifactSubmittedBy,
    sourceType: artifactSource,
  });
}

async function seedEligibleRuns(count: number, coachId: string) {
  for (let index = 0; index < count; index += 1) {
    const id = `run_train_${index}`;
    await seedMentorRun({ id, mentorId: coachId });
    await recordApprenticeObservation(DEMO_USER_ID, id);
  }
}

describe("apprentice training evidence", () => {
  it("rejects a run that the mentor did not execute", async () => {
    const chief = await agentByRole("chief");
    await seedMentorRun({ id: "run_chief_work", mentorId: chief.id });

    await expect(
      recordApprenticeObservation(DEMO_USER_ID, "run_chief_work"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects simulated runs even when they succeeded on an accepted task", async () => {
    const coach = await agentByRole("coach");
    await seedMentorRun({
      id: "run_demo",
      mentorId: coach.id,
      mode: "demo",
      providerAttemptId: null,
      artifactSource: "demo_fixture",
    });

    await expect(
      recordApprenticeObservation(DEMO_USER_ID, "run_demo"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a run whose task was never accepted", async () => {
    const coach = await agentByRole("coach");
    await seedMentorRun({
      id: "run_submitted",
      mentorId: coach.id,
      taskStatus: "submitted",
    });

    await expect(
      recordApprenticeObservation(DEMO_USER_ID, "run_submitted"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("records one eligible mentor run and shows it in the evidence list", async () => {
    const coach = await agentByRole("coach");
    await seedMentorRun({ id: "run_ok", mentorId: coach.id });

    const result = await recordApprenticeObservation(DEMO_USER_ID, "run_ok");
    expect(result).toMatchObject({ runId: "run_ok", duplicate: false });

    const [observation] = await db
      .select()
      .from(apprenticeObservations)
      .where(eq(apprenticeObservations.runId, "run_ok"));
    expect(observation.mentorId).toBe(coach.id);
    expect(observation.qualification).toBe("qualified");

    const evidence = await loadApprenticeshipEvidence(DEMO_USER_ID);
    expect(evidence.observed).toBe(1);
    expect(evidence.required).toBe(APPRENTICE_SKILL.minShadowRuns);
    expect(evidence.candidates.map((run) => run.runId)).not.toContain("run_ok");
  });

  it("records the same mentor run only once", async () => {
    const coach = await agentByRole("coach");
    await seedMentorRun({ id: "run_once", mentorId: coach.id });

    await recordApprenticeObservation(DEMO_USER_ID, "run_once");
    const again = await recordApprenticeObservation(DEMO_USER_ID, "run_once");
    expect(again.duplicate).toBe(true);

    const rows = await db
      .select()
      .from(apprenticeObservations)
      .where(eq(apprenticeObservations.runId, "run_once"));
    expect(rows).toHaveLength(1);
  });

  it("refuses the exam while observations are below the threshold", async () => {
    const coach = await agentByRole("coach");
    await seedEligibleRuns(APPRENTICE_SKILL.minShadowRuns - 1, coach.id);

    await expect(runApprenticeExam(DEMO_USER_ID)).rejects.toThrow(
      /观摩/,
    );
  });

  it("treats a passing exam as practice only", async () => {
    const coach = await agentByRole("coach");
    const [before] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_apprentice"));
    await seedEligibleRuns(APPRENTICE_SKILL.minShadowRuns, coach.id);

    const result = await runApprenticeExam(DEMO_USER_ID);
    expect(result).toMatchObject({
      passed: 5,
      required: 5,
      promoted: false,
      practicePassed: true,
      observed: APPRENTICE_SKILL.minShadowRuns,
    });

    const [after] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_apprentice"));
    expect(after.lifecycleStage).toBe("practice_passed");
    expect(after.status).not.toBe("active");
    expect(after.autonomyLevel).toBe(before.autonomyLevel);
    expect(after.trustScore).toBe(before.trustScore);

    const [skill] = await db
      .select()
      .from(skills)
      .where(eq(skills.agentId, "ag_apprentice"))
      .orderBy(desc(skills.createdAt))
      .limit(1);
    expect(skill.label).not.toBe("production");
    expect(skill.status).not.toBe("active");

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "apprentice.practice_passed"));
    expect(event).toBeTruthy();

    const [snapshot] = await db
      .select()
      .from(apprenticeExamSnapshots)
      .where(eq(apprenticeExamSnapshots.apprenticeId, "ag_apprentice"));
    expect(snapshot.observationIds).toHaveLength(
      APPRENTICE_SKILL.minShadowRuns,
    );
    expect(snapshot.passed).toBe(true);
  });

  it("refuses a second exam once practice passed", async () => {
    const coach = await agentByRole("coach");
    await seedEligibleRuns(APPRENTICE_SKILL.minShadowRuns, coach.id);
    await runApprenticeExam(DEMO_USER_ID);

    await expect(runApprenticeExam(DEMO_USER_ID)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("retires the apprentice after two failed attempts and keeps both snapshots", async () => {
    const coach = await agentByRole("coach");
    await seedEligibleRuns(APPRENTICE_SKILL.minShadowRuns, coach.id);
    // A checklist the deterministic exam draft cannot satisfy.
    const impossible = [
      { type: "contains" as const, value: "不可能出现的短语", required: true },
    ];
    await db
      .update(skills)
      .set({ evalSet: impossible })
      .where(eq(skills.agentId, "ag_apprentice"));

    const first = await runApprenticeExam(DEMO_USER_ID);
    expect(first.retired).toBe(false);
    const second = await runApprenticeExam(DEMO_USER_ID);
    expect(second.retired).toBe(true);

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_apprentice"));
    expect(agent.lifecycleStage).toBe("retired");

    const snapshots = await db
      .select()
      .from(apprenticeExamSnapshots)
      .where(eq(apprenticeExamSnapshots.apprenticeId, "ag_apprentice"))
      .orderBy(apprenticeExamSnapshots.attemptNo);
    expect(snapshots.map((row) => row.attemptNo)).toEqual([1, 2]);
    expect(snapshots.every((row) => row.passed === false)).toBe(true);
    expect(snapshots.every((row) => row.observationIds.length === 5)).toBe(true);
  });

  it("serialises concurrent exam attempts", async () => {
    const coach = await agentByRole("coach");
    await seedEligibleRuns(APPRENTICE_SKILL.minShadowRuns, coach.id);

    const results = await Promise.allSettled([
      runApprenticeExam(DEMO_USER_ID),
      runApprenticeExam(DEMO_USER_ID),
    ]);
    const fulfilled = results.filter((row) => row.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const attemptOne = await db
      .select()
      .from(apprenticeExamSnapshots)
      .where(
        and(
          eq(apprenticeExamSnapshots.apprenticeId, "ag_apprentice"),
          eq(apprenticeExamSnapshots.attemptNo, 1),
        ),
      );
    expect(attemptOne).toHaveLength(1);
  });
});
