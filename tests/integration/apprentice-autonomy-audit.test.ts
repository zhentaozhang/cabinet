import { DEMO_USER_ID } from "@/lib/demo";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, auditEvents, tasks } from "@/lib/db/schema";
import { runApprenticeExam, setAutonomy } from "@/lib/engine";
import { verifyAuditChain } from "@/lib/audit";
import { ConflictError, PolicyDenied } from "@/lib/domain/errors";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("apprenticeship lifecycle", () => {
  it("promotes exactly once", async () => {
    const result = await runApprenticeExam(DEMO_USER_ID);
    expect(result).toMatchObject({ passed: 5, required: 5 });

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_apprentice"));
    expect(agent.lifecycleStage).toBe("active");

    await expect(runApprenticeExam(DEMO_USER_ID)).rejects.toBeInstanceOf(ConflictError);
  });

  it("records the exam on a synthetic task, not on a real task", async () => {
    const result = await runApprenticeExam(DEMO_USER_ID);
    const [runTaskRow] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, `exam_ag_apprentice`));
    expect(runTaskRow).toBeTruthy();
    expect(result.runId).toBeTruthy();
  });
});

describe("autonomy gate", () => {
  it("allows the chief after a clean audit window", async () => {
    const result = await setAutonomy("ag_chief", 3, DEMO_USER_ID);
    expect(result.level).toBe(3);
    expect(result.auditPassRate).toBe(1);
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
