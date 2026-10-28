import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, artifacts, auditEvents, runs, tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import {
  auditTask,
  evaluateAutonomyUpgrade,
  setAutonomy,
  updateAgent,
} from "@/server/services/engine";
import { PolicyDenied } from "@/lib/domain/errors";
import { loadReview } from "@/server/readmodels/review";
import { resetDb } from "../helpers/db";

/**
 * Autonomy must be earned by real model execution, not by any activity.
 *
 * Every case seeds an accepted task whose artifact/run provenance decides
 * whether the audit counts as evidence.
 */

type Provenance =
  | "eligible"
  | "demo"
  | "rule"
  | "user_submitted"
  | "legacy_unknown"
  | "demo_channel";

const PROVENANCE: Record<
  Provenance,
  {
    submittedBy: "agent" | "user";
    sourceType: string;
    mode: string;
    providerAttemptId: string | null;
  }
> = {
  eligible: {
    submittedBy: "agent",
    sourceType: "model_generated",
    mode: "live",
    providerAttemptId: "att_evidence",
  },
  demo: {
    submittedBy: "agent",
    sourceType: "demo_fixture",
    mode: "live",
    providerAttemptId: "att_evidence",
  },
  rule: {
    submittedBy: "agent",
    sourceType: "rule_generated",
    mode: "live",
    providerAttemptId: "att_evidence",
  },
  user_submitted: {
    submittedBy: "user",
    sourceType: "model_generated",
    mode: "live",
    providerAttemptId: "att_evidence",
  },
  legacy_unknown: {
    submittedBy: "agent",
    sourceType: "legacy_unknown",
    mode: "live",
    providerAttemptId: null,
  },
  demo_channel: {
    submittedBy: "agent",
    sourceType: "model_generated",
    mode: "demo",
    providerAttemptId: null,
  },
};

async function seedSubmission(input: {
  taskId: string;
  agentId: string;
  provenance: Provenance;
  index?: number;
}): Promise<void> {
  const [auditor] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, DEMO_USER_ID), eq(agents.role, "auditor")));
  const p = PROVENANCE[input.provenance];
  await db.insert(tasks).values({
    id: input.taskId,
    userId: DEMO_USER_ID,
    title: `证据任务 ${input.taskId}`,
    description: "为授权证据测试生成的验收任务。",
    assigneeId: input.agentId,
    auditorId: auditor.id,
    status: "submitted",
    acceptanceCriteria: "产物存在并通过验收标准。",
    // A definite rule, so the seeded submission reaches a real verdict instead
    // of stopping at "needs_review" (which would not count as a sample).
    acceptanceChecklist: [{ type: "min_words", value: 1, required: true }],
    estimateMin: 10,
    actionType: "internal",
    resource: "task",
  });
  await db.insert(runs).values({
    id: `run_${input.taskId}`,
    taskId: input.taskId,
    agentId: input.agentId,
    status: "succeeded",
    mode: p.mode,
    sourceType: p.sourceType,
    providerAttemptId: p.providerAttemptId,
    startedAt: new Date(),
    endedAt: new Date(),
    createdAt: new Date(Date.now() - 1000),
  });
  await db.insert(artifacts).values({
    id: `art_${input.taskId}`,
    taskId: input.taskId,
    // Eligibility is read off the run that produced the artifact, so the
    // fixture has to link the two the way run.ts does.
    runId: `run_${input.taskId}`,
    submittedBy: p.submittedBy,
    sourceType: p.sourceType,
    type: "note",
    title: "产物",
    content: "## 结论\n\n完成。",
  });
}

/** Audits one seeded submission and returns the verdict. */
async function auditOne(
  taskId: string,
  agentId: string,
  provenance: Provenance,
): Promise<"accepted" | "rejected" | "needs_review"> {
  await seedSubmission({ taskId, agentId, provenance });
  const result = await auditTask(taskId, DEMO_USER_ID);
  return result.decision;
}

async function agentByRole(role: string) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, DEMO_USER_ID), eq(agents.role, role)));
  return agent;
}

async function raiseTrust(agentId: string, successCount: number, trust: number) {
  await db
    .update(agents)
    .set({ successCount, trustScore: trust, failCount: 0 })
    .where(eq(agents.id, agentId));
}

beforeEach(async () => {
  await resetDb();
});

describe("autonomy evidence", () => {
  it("refuses a promotion without enough eligible audit samples", async () => {
    const coach = await agentByRole("coach");
    await raiseTrust(coach.id, 6, 95);
    await auditOne("tsk_ev_1", coach.id, "eligible");
    await auditOne("tsk_ev_2", coach.id, "eligible");

    const decision = await evaluateAutonomyUpgrade(coach.id, 3, DEMO_USER_ID);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("insufficient_samples");
    expect(decision.samples).toBe(2);
    expect(decision.passRate).toBe(1);

    await expect(
      setAutonomy(coach.id, 3, DEMO_USER_ID),
    ).rejects.toBeInstanceOf(PolicyDenied);
    const [after] = await db.select().from(agents).where(eq(agents.id, coach.id));
    expect(after.autonomyLevel).toBe(coach.autonomyLevel);
  });

  it("does not count demo, rule, user-submitted or legacy output", async () => {
    const coach = await agentByRole("coach");
    await raiseTrust(coach.id, 8, 95);
    await auditOne("tsk_ev_demo", coach.id, "demo");
    await auditOne("tsk_ev_rule", coach.id, "rule");
    await auditOne("tsk_ev_user", coach.id, "user_submitted");
    await auditOne("tsk_ev_legacy", coach.id, "legacy_unknown");
    await auditOne("tsk_ev_channel", coach.id, "demo_channel");

    const decision = await evaluateAutonomyUpgrade(coach.id, 3, DEMO_USER_ID);
    expect(decision.samples).toBe(0);
    expect(decision.code).toBe("insufficient_samples");
  });

  it("credits the run that produced the artifact, not a later failed retry", async () => {
    const coach = await agentByRole("coach");
    await raiseTrust(coach.id, 6, 95);
    await seedSubmission({
      taskId: "tsk_ev_retry",
      agentId: coach.id,
      provenance: "eligible",
    });
    // A rejected draft gets re-run, and that retry dies before it ever reaches
    // the provider, so its run row carries no provider attempt. The audit must
    // still read the live run that produced the artifact.
    await db.insert(runs).values({
      id: "run_tsk_ev_retry_failed",
      taskId: "tsk_ev_retry",
      agentId: coach.id,
      status: "failed",
      mode: "live",
      sourceType: "model_generated",
      providerAttemptId: null,
      startedAt: new Date(),
      createdAt: new Date(),
    });

    const verdict = await auditTask("tsk_ev_retry", DEMO_USER_ID);
    expect(verdict.decision).toBe("accepted");

    const [after] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, coach.id));
    expect(after.successCount).toBe(7);
    expect(after.trustScore).toBe(96);
  });
  it("promotes on five eligible distinct tasks at a passing rate", async () => {
    const coach = await agentByRole("coach");
    await raiseTrust(coach.id, 6, 95);
    for (const n of [1, 2, 3, 4, 5]) {
      const verdict = await auditOne(`tsk_ok_${n}`, coach.id, "eligible");
      expect(verdict).toBe("accepted");
    }

    const decision = await evaluateAutonomyUpgrade(coach.id, 3, DEMO_USER_ID);
    expect(decision).toMatchObject({
      allowed: true,
      code: null,
      samples: 5,
      passRate: 1,
    });

    const result = await setAutonomy(coach.id, 3, DEMO_USER_ID);
    expect(result).toMatchObject({ level: 3, samples: 5 });
    expect(result.code).toBeNull();
  });

  it("blocks a promotion whose eligible pass rate is too low", async () => {
    const coach = await agentByRole("coach");
    await raiseTrust(coach.id, 8, 95);
    for (const n of [1, 2, 3, 4]) {
      await auditOne(`tsk_pass_${n}`, coach.id, "eligible");
    }
    // One eligible task the auditor rejects through a failing checklist item.
    // It keeps its provenance, so it counts as a sample — just a failed one.
    // Only one: two consecutive rejects would pause the Agent (another gate).
    const taskId = "tsk_fail_5";
    await seedSubmission({ taskId, agentId: coach.id, provenance: "eligible" });
    await db
      .update(tasks)
      .set({
        acceptanceChecklist: [
          { type: "min_sources", value: 2, required: true },
        ],
      })
      .where(eq(tasks.id, taskId));
    const rejected = await auditTask(taskId, DEMO_USER_ID);
    expect(rejected.decision).toBe("rejected");

    const decision = await evaluateAutonomyUpgrade(coach.id, 3, DEMO_USER_ID);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("low_pass_rate");
    expect(decision.samples).toBe(5);
    expect(decision.passRate).toBeCloseTo(0.8, 5);
  });

  it("always allows a downgrade, even for a paused agent", async () => {
    const coach = await agentByRole("coach");
    await db
      .update(agents)
      .set({ status: "paused", trustScore: 10, successCount: 0 })
      .where(eq(agents.id, coach.id));

    const decision = await evaluateAutonomyUpgrade(coach.id, 1, DEMO_USER_ID);
    expect(decision).toMatchObject({ allowed: true, code: null });

    const result = await setAutonomy(coach.id, 1, DEMO_USER_ID);
    expect(result.level).toBe(1);
  });

  it("refuses a promotion for a paused agent", async () => {
    const coach = await agentByRole("coach");
    await raiseTrust(coach.id, 9, 99);
    await updateAgent(coach.id, { status: "paused" }, DEMO_USER_ID);

    const decision = await evaluateAutonomyUpgrade(coach.id, 3, DEMO_USER_ID);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("paused");
    await expect(
      setAutonomy(coach.id, 3, DEMO_USER_ID),
    ).rejects.toBeInstanceOf(PolicyDenied);
  });

  it("records the sample count and pass rate on the audit trail", async () => {
    const coach = await agentByRole("coach");
    await raiseTrust(coach.id, 6, 95);
    for (const n of [1, 2, 3, 4, 5]) {
      await auditOne(`tsk_trail_${n}`, coach.id, "eligible");
    }
    await setAutonomy(coach.id, 3, DEMO_USER_ID);

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, DEMO_USER_ID),
          eq(auditEvents.action, "autonomy.change"),
          eq(auditEvents.target, coach.id),
        ),
      );
    expect(event).toBeDefined();
    const payload = event.after as Record<string, unknown>;
    expect(payload.samples).toBe(5);
    expect(payload.passRate).toBe(1);
    expect(payload.code).toBeNull();
  });

  it("shows the same decision on the Review page as the command path", async () => {
    const coach = await agentByRole("coach");
    await raiseTrust(coach.id, 6, 95);
    await auditOne("tsk_rev_1", coach.id, "eligible");

    const decision = await evaluateAutonomyUpgrade(coach.id, 3, DEMO_USER_ID);
    const page = await loadReview(DEMO_USER_ID, {
      insightOffset: 0,
      dissentOffset: 0,
      limit: 10,
    });
    const shown = page.autonomyDecisions[coach.id];
    expect(shown).toBeDefined();
    expect(shown.allowed).toBe(decision.allowed);
    expect(shown.code).toBe(decision.code);
    expect(shown.samples).toBe(decision.samples);
    expect(shown.passRate).toBe(decision.passRate);
  });
});

describe("autonomy and audit concurrency", () => {
  it("does not lose counters when two audits run at once", async () => {
    const coach = await agentByRole("coach");
    await raiseTrust(coach.id, 0, 80);
    await seedSubmission({
      taskId: "tsk_conc_1",
      agentId: coach.id,
      provenance: "eligible",
    });
    await seedSubmission({
      taskId: "tsk_conc_2",
      agentId: coach.id,
      provenance: "eligible",
    });

    const results = await Promise.all([
      auditTask("tsk_conc_1", DEMO_USER_ID),
      auditTask("tsk_conc_2", DEMO_USER_ID),
    ]);
    expect(results.map((r) => r.decision)).toEqual(["accepted", "accepted"]);

    const [after] = await db.select().from(agents).where(eq(agents.id, coach.id));
    expect(after.successCount).toBe(2);
    expect(after.trustScore).toBe(82);
    expect(after.rejectStreak).toBe(0);
  });

  it("cannot promote an agent paused by a concurrent command", async () => {
    const coach = await agentByRole("coach");
    await raiseTrust(coach.id, 9, 99);
    for (const n of [1, 2, 3, 4, 5]) {
      await auditOne(`tsk_race_${n}`, coach.id, "eligible");
    }

    await updateAgent(coach.id, { status: "paused" }, DEMO_USER_ID);
    const attempts = await Promise.allSettled([
      setAutonomy(coach.id, 3, DEMO_USER_ID),
      setAutonomy(coach.id, 3, DEMO_USER_ID),
    ]);
    expect(attempts.every((a) => a.status === "rejected")).toBe(true);

    const [after] = await db.select().from(agents).where(eq(agents.id, coach.id));
    expect(after.status).toBe("paused");
    expect(after.autonomyLevel).toBe(coach.autonomyLevel);
  });
});
