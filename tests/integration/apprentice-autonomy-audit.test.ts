import { DEMO_USER_ID } from "@/lib/demo";
import { beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  apprenticeExamSnapshots,
  artifacts,
  auditEvents,
  runs,
  skills,
  tasks,
  users,
} from "@/lib/db/schema";
import {
  recordApprenticeObservation,
  runApprenticeExam,
  setAutonomy,
  updateAgent,
} from "@/server/services/engine";
import { verifyAuditChain } from "@/lib/audit";
import {
  ConflictError,
  PolicyDenied,
  ValidationError,
} from "@/lib/domain/errors";
import { setupWorkspace } from "@/lib/setup";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

/**
 * Seeds `count` mentor runs that qualify as training evidence (live execution, a
 * provider attempt, an accepted task and an agent artifact) and records each one
 * through the command path, so the exam gate is exercised end to end.
 */
async function seedShadowRuns(
  userId: string,
  mentorId: string,
  count = 5,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const runId = `run_shadow_${mentorId}_${index}`;
    const taskId = `tsk_shadow_${mentorId}_${index}`;
    await db.insert(tasks).values({
      id: taskId,
      userId,
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
      runLabel: `shadow_${mentorId}_${index}`,
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
    await recordApprenticeObservation(userId, runId);
  }
}

async function agentByRole(userId: string, role: string) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.role, role)))
    .limit(1);
  return agent;
}

describe("apprenticeship lifecycle", () => {
  it("practice-passes exactly once without promoting", async () => {
    const coach = await agentByRole(DEMO_USER_ID, "coach");
    const [before] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_apprentice"));
    await seedShadowRuns(DEMO_USER_ID, coach.id);

    const result = await runApprenticeExam(DEMO_USER_ID);
    expect(result).toMatchObject({
      passed: 5,
      required: 5,
      promoted: false,
      practicePassed: true,
      observed: 5,
      requiredObservations: 5,
    });

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_apprentice"));
    expect(agent.lifecycleStage).toBe("practice_passed");
    expect(agent.status).toBe(before.status);
    expect(agent.autonomyLevel).toBe(before.autonomyLevel);
    expect(agent.trustScore).toBe(before.trustScore);

    const [skill] = await db
      .select()
      .from(skills)
      .where(eq(skills.agentId, "ag_apprentice"));
    expect(skill.label).toBe("practice");
    expect(skill.status).not.toBe("active");

    await expect(runApprenticeExam(DEMO_USER_ID)).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses the exam before enough recorded observations", async () => {
    await expect(runApprenticeExam(DEMO_USER_ID)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("practice-passes a newly registered workspace with random agent ids", async () => {
    const userId = "usr_apprentice_new";
    await db.insert(users).values({
      id: userId,
      email: "apprentice-new@cabinet.local",
      name: "New Apprentice",
      emailVerified: true,
      timezone: "Asia/Shanghai",
      updatedAt: new Date(),
    });
    await setupWorkspace({ userId, timezone: "Asia/Shanghai" });
    const coach = await agentByRole(userId, "coach");
    await seedShadowRuns(userId, coach.id);

    const result = await runApprenticeExam(userId);
    expect(result).toMatchObject({
      passed: 5,
      required: 5,
      promoted: false,
      practicePassed: true,
    });

    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.userId, userId), eq(agents.role, "apprentice")));
    expect(agent.lifecycleStage).toBe("practice_passed");
    expect(agent.autonomyLevel).toBe(1);

    const [skill] = await db
      .select()
      .from(skills)
      .where(eq(skills.agentId, agent.id));
    expect(skill.label).toBe("practice");
  });

  it("records the exam as a submitted task with a real audit accept", async () => {
    const coach = await agentByRole(DEMO_USER_ID, "coach");
    await seedShadowRuns(DEMO_USER_ID, coach.id);

    const result = await runApprenticeExam(DEMO_USER_ID);
    const [runTaskRow] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, `exam_ag_apprentice`));
    expect(runTaskRow).toBeTruthy();
    expect(runTaskRow.status).toBe("accepted");
    expect(result.runId).toBeTruthy();

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "audit.accept"),
          eq(auditEvents.target, "exam_ag_apprentice"),
        ),
      );
    expect(audit).toBeDefined();
  });

  it("retires the apprentice after two failed exam attempts", async () => {
    const coach = await agentByRole(DEMO_USER_ID, "coach");
    await seedShadowRuns(DEMO_USER_ID, coach.id);
    const [skill] = await db
      .select()
      .from(skills)
      .where(eq(skills.agentId, "ag_apprentice"));

    await db
      .update(skills)
      .set({
        evalSet: [
          ...(skill.evalSet ?? []),
          { type: "contains", value: "不存在的验收关键词", required: true },
        ],
      })
      .where(eq(skills.id, skill.id));

    const first = await runApprenticeExam(DEMO_USER_ID);
    expect(first).toMatchObject({ promoted: false, retired: false });

    const [afterFirst] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_apprentice"));
    expect(afterFirst.lifecycleStage).toBe("drafting");
    const [skillAfterFirst] = await db
      .select()
      .from(skills)
      .where(eq(skills.id, skill.id));
    expect(skillAfterFirst.failCount).toBe(1);

    const second = await runApprenticeExam(DEMO_USER_ID);
    expect(second).toMatchObject({ promoted: false, retired: true });

    const [afterSecond] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_apprentice"));
    expect(afterSecond.status).toBe("retired");
    expect(afterSecond.lifecycleStage).toBe("retired");
    expect(afterSecond.retiredAt).not.toBeNull();

    const [retiredAudit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "apprentice.retired"));
    expect(retiredAudit).toBeDefined();

    const snapshots = await db
      .select()
      .from(apprenticeExamSnapshots)
      .where(eq(apprenticeExamSnapshots.apprenticeId, "ag_apprentice"))
      .orderBy(apprenticeExamSnapshots.attemptNo);
    expect(snapshots.map((row) => row.attemptNo)).toEqual([1, 2]);
    expect(snapshots.every((row) => row.observationIds.length === 5)).toBe(true);

    const chain = await verifyAuditChain(DEMO_USER_ID);
    expect(chain.ok).toBe(true);
  });

  it("refuses an apprentice whose status is retired", async () => {
    await db
      .update(agents)
      .set({ status: "retired" })
      .where(eq(agents.id, "ag_apprentice"));

    await expect(runApprenticeExam(DEMO_USER_ID)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("refuses an apprentice whose lifecycle is no longer in training", async () => {
    await db
      .update(agents)
      .set({ status: "active", lifecycleStage: "active" })
      .where(eq(agents.id, "ag_apprentice"));

    await expect(runApprenticeExam(DEMO_USER_ID)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe("agent retirement bookkeeping", () => {
  it("sets lifecycleStage and retiredAt together with status", async () => {
    const updated = await updateAgent(
      "ag_critic",
      { status: "retired" },
      DEMO_USER_ID,
    );

    expect(updated.status).toBe("retired");
    expect(updated.lifecycleStage).toBe("retired");
    expect(updated.retiredAt).not.toBeNull();

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "agent.update"),
          eq(auditEvents.target, "ag_critic"),
        ),
      )
      .orderBy(desc(auditEvents.seq))
      .limit(1);
    expect(audit.after).toMatchObject({
      status: "retired",
      lifecycleStage: "retired",
    });

    const chain = await verifyAuditChain(DEMO_USER_ID);
    expect(chain.ok).toBe(true);
  });
});

/**
 * Seeds `count` audited tasks whose provenance is real model execution, which is
 * the only kind of evidence a promotion may count. Demo fixtures, rule drafts
 * and pre-ledger runs deliberately do not qualify.
 */
async function seedEligibleAudits(
  agentId: string,
  auditorId: string,
  count = 5,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const taskId = `tsk_eligible_${agentId}_${index}`;
    await db.insert(tasks).values({
      id: taskId,
      userId: DEMO_USER_ID,
      title: `授权证据 ${index}`,
      description: "真实模型执行产生的验收任务。",
      assigneeId: agentId,
      auditorId,
      status: "accepted",
      acceptanceCriteria: "产物存在。",
      estimateMin: 10,
      actionType: "internal",
      resource: "task",
    });
    await db.insert(runs).values({
      id: `run_eligible_${agentId}_${index}`,
      taskId,
      agentId,
      status: "succeeded",
      mode: "live",
      sourceType: "model_generated",
      providerAttemptId: `att_eligible_${agentId}_${index}`,
      startedAt: new Date(),
      endedAt: new Date(),
    });
    await db.insert(artifacts).values({
      id: `art_eligible_${agentId}_${index}`,
      taskId,
      runId: `run_eligible_${agentId}_${index}`,
      submittedBy: "agent",
      sourceType: "model_generated",
      type: "note",
      title: "产物",
      content: "## 结论\n\n完成。",
    });
    await db.insert(auditEvents).values({
      id: `evt_eligible_${agentId}_${index}`,
      userId: DEMO_USER_ID,
      actor: `agent:${auditorId}`,
      action: "audit.accept",
      target: taskId,
      hash: `hash_eligible_${agentId}_${index}`,
      prevHash: null,
    });
  }
}

describe("autonomy gate", () => {
  it("allows the chief after a clean eligible audit window", async () => {
    await seedEligibleAudits("ag_chief", "ag_auditor");
    const result = await setAutonomy("ag_chief", 3, DEMO_USER_ID);
    expect(result.level).toBe(3);
    expect(result.passRate).toBe(1);
    expect(result.samples).toBeGreaterThanOrEqual(5);
  });

  it("blocks an agent below the trust threshold", async () => {
    await expect(setAutonomy("ag_coach", 3, DEMO_USER_ID)).rejects.toBeInstanceOf(
      PolicyDenied,
    );
  });
});

describe("audit chain", () => {
  it("verifies the seeded chain", async () => {
    const result = await verifyAuditChain("usr_zhen");
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThan(0);
  });

  it("detects tampering", async () => {
    await db
      .update(auditEvents)
      .set({ after: { status: "tampered" } })
      .where(eq(auditEvents.id, "aud_seed_2"));

    const result = await verifyAuditChain("usr_zhen");
    expect(result.ok).toBe(false);
    expect(result.firstMismatch).toBe("aud_seed_2");
  });
});
