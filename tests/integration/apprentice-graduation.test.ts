import { DEMO_USER_ID } from "@/lib/demo";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  artifacts,
  auditEvents,
  runs,
  skills,
  tasks,
} from "@/lib/db/schema";
import {
  graduateApprentice,
  recordApprenticeObservation,
  runApprenticeExam,
} from "@/server/services/engine";
import { ConflictError, PolicyDenied } from "@/lib/domain/errors";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

/** Seeds mentor runs that qualify as training evidence (same shape the exam gate uses). */
async function seedShadowRuns(mentorId: string, count = 5): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const runId = `run_shadow_${mentorId}_${index}`;
    const taskId = `tsk_shadow_${mentorId}_${index}`;
    await db.insert(tasks).values({
      id: taskId,
      userId: DEMO_USER_ID,
      title: "Mentor shadow run",
      description: "Synthetic mentor task used to seed successful shadow runs.",
      assigneeId: mentorId,
      status: "accepted",
      acceptanceCriteria: "记录一次 mentor 的成功运行。",
      estimateMin: 10,
      actionType: "internal",
      resource: "task",
    });
    await db.insert(runs).values({
      id: runId,
      taskId,
      agentId: mentorId,
      status: "succeeded",
      mode: "live",
      providerAttemptId: `att_shadow_${mentorId}_${index}`,
      sourceType: "system_event",
      startedAt: new Date(),
      endedAt: new Date(),
      replayKey: `shadow_${mentorId}_${index}`,
    });
    await db.insert(artifacts).values({
      id: `art_shadow_${mentorId}_${index}`,
      runId,
      taskId,
      type: "markdown",
      title: "Mentor shadow output",
      content: "mentor output",
      submittedBy: "agent",
      sourceType: "model_generated",
    });
    await recordApprenticeObservation(DEMO_USER_ID, runId);
  }
}

/** Real audited work for the apprentice: eligible samples, all accepted. */
async function seedEligibleAudits(count = 5): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const taskId = `tsk_real_${index}`;
    await db.insert(tasks).values({
      id: taskId,
      userId: DEMO_USER_ID,
      title: `真实任务 ${index}`,
      description: "学徒自己执行、并被审计接受的任务。",
      assigneeId: "ag_apprentice",
      auditorId: "ag_auditor",
      status: "accepted",
      acceptanceCriteria: "产物存在。",
      estimateMin: 10,
      actionType: "internal",
      resource: "task",
    });
    await db.insert(runs).values({
      id: `run_real_${index}`,
      taskId,
      agentId: "ag_apprentice",
      status: "succeeded",
      mode: "live",
      sourceType: "model_generated",
      providerAttemptId: `att_real_${index}`,
      startedAt: new Date(),
      endedAt: new Date(),
    });
    await db.insert(artifacts).values({
      id: `art_real_${index}`,
      taskId,
      submittedBy: "agent",
      sourceType: "model_generated",
      type: "note",
      title: "产物",
      content: "## 结论\n\n完成。",
    });
    await db.insert(auditEvents).values({
      id: `evt_real_${index}`,
      userId: DEMO_USER_ID,
      actor: "agent:ag_auditor",
      action: "audit.accept",
      target: taskId,
      hash: `hash_real_${index}`,
      prevHash: null,
    });
  }
}

async function practicePass(): Promise<void> {
  await seedShadowRuns("ag_coach");
  const result = await runApprenticeExam(DEMO_USER_ID);
  expect(result.practicePassed).toBe(true);
}

async function clearFloors(): Promise<void> {
  await db
    .update(agents)
    .set({ trustScore: 75, successCount: 5 })
    .where(eq(agents.id, "ag_apprentice"));
}

describe("apprentice graduation", () => {
  it("refuses to graduate an apprentice who has not passed the practice exam", async () => {
    await expect(graduateApprentice(DEMO_USER_ID)).rejects.toBeInstanceOf(
      PolicyDenied,
    );
    await expect(graduateApprentice(DEMO_USER_ID)).rejects.toThrow(/练习考核/);
  });

  it("names missing trust instead of leaving the apprentice stuck silently", async () => {
    await practicePass();
    // Demo apprentice sits at trust 42 with 2 successes — real work has to happen
    // before 转正, which is the difference from the deterministic practice exam.
    await expect(graduateApprentice(DEMO_USER_ID)).rejects.toThrow(/信任分/);
  });

  it("does not accept trust and successes as a substitute for audited evidence", async () => {
    await practicePass();
    await clearFloors();
    await expect(graduateApprentice(DEMO_USER_ID)).rejects.toThrow(/审计样本/);
  });

  it("graduates once real audited work clears every floor", async () => {
    await practicePass();
    await clearFloors();
    await seedEligibleAudits();

    const result = await graduateApprentice(DEMO_USER_ID);
    expect(result.graduated).toBe(true);
    expect(result.samples).toBeGreaterThanOrEqual(5);
    expect(result.passRate).toBe(1);

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_apprentice"));
    expect(agent.lifecycleStage).toBe("active");
    expect(agent.status).toBe("active");

    const [skill] = await db
      .select()
      .from(skills)
      .where(eq(skills.agentId, "ag_apprentice"));
    expect(skill.status).toBe("active");
    expect(skill.label).toBe("v1");

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "apprentice.graduated"));
    expect(event?.target).toBe("ag_apprentice");
    expect((event?.after as { stage?: string } | null)?.stage).toBe("active");

    await expect(graduateApprentice(DEMO_USER_ID)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});
