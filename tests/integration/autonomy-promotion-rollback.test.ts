import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const auditFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...actual,
    logAuditTx: async (
      tx: unknown,
      entry: { action: string },
      ...rest: unknown[]
    ) => {
      if (auditFailure.enabled && entry.action === "autonomy.change") {
        throw new Error("audit log unavailable");
      }
      return (
        actual.logAuditTx as unknown as (
          tx: unknown,
          entry: { action: string },
          ...rest: unknown[]
        ) => Promise<unknown>
      )(tx, entry, ...rest);
    },
  };
});

const { db } = await import("@/lib/db");
const { agents, artifacts, auditEvents, runs, tasks } = await import(
  "@/lib/db/schema"
);
const { DEMO_USER_ID } = await import("@/lib/demo");
const { setAutonomy } = await import("@/server/services/engine");
const { resetDb } = await import("../helpers/db");

async function seedEligibleAudit(taskId: string, agentId: string, auditorId: string) {
  await db.insert(tasks).values({
    id: taskId,
    userId: DEMO_USER_ID,
    title: `回滚证据 ${taskId}`,
    description: "回滚测试用验收任务。",
    assigneeId: agentId,
    auditorId,
    status: "accepted",
    acceptanceCriteria: "产物存在。",
    estimateMin: 10,
    actionType: "internal",
    resource: "task",
  });
  await db.insert(runs).values({
    id: `run_${taskId}`,
    taskId,
    agentId,
    status: "succeeded",
    mode: "live",
    sourceType: "model_generated",
    providerAttemptId: `att_${taskId}`,
    startedAt: new Date(),
    endedAt: new Date(),
  });
  await db.insert(artifacts).values({
    id: `art_${taskId}`,
    taskId,
    runId: `run_${taskId}`,
    submittedBy: "agent",
    sourceType: "model_generated",
    type: "note",
    title: "产物",
    content: "## 结论\n\n完成。",
  });
  await db.insert(auditEvents).values({
    id: `evt_${taskId}`,
    userId: DEMO_USER_ID,
    actor: "agent:ag_auditor",
    action: "audit.accept",
    target: taskId,
    hash: `hash_${taskId}`,
    prevHash: null,
  });
}

beforeEach(async () => {
  auditFailure.enabled = false;
  await resetDb();
});

describe("promotion transaction", () => {
  it("rolls the level back when the audit log write fails", async () => {
    const coach = (
      await db
        .select()
        .from(agents)
        .where(and(eq(agents.userId, DEMO_USER_ID), eq(agents.role, "coach")))
    )[0];
    await db
      .update(agents)
      .set({ successCount: 9, trustScore: 99, failCount: 0 })
      .where(eq(agents.id, coach.id));
    for (const n of [1, 2, 3, 4, 5]) {
      await seedEligibleAudit(`tsk_rb_${n}`, coach.id, "ag_auditor");
    }
    const before = coach.autonomyLevel;

    auditFailure.enabled = true;
    await expect(setAutonomy(coach.id, 3, DEMO_USER_ID)).rejects.toThrow(
      /audit log unavailable/,
    );

    const [after] = await db.select().from(agents).where(eq(agents.id, coach.id));
    expect(after.autonomyLevel).toBe(before);

    const events = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, DEMO_USER_ID),
          eq(auditEvents.action, "autonomy.change"),
        ),
      );
    expect(events).toHaveLength(0);
  });
});
