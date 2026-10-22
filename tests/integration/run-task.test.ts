import { DEMO_USER_ID } from "@/lib/demo";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, runs, tasks } from "@/lib/db/schema";
import {
  auditTask,
  decideApproval,
  runTask,
} from "@/lib/engine";
import { ConflictError, PolicyDenied } from "@/lib/domain/errors";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("runtime policy enforcement", () => {
  it("blocks a paused agent", async () => {
    await db
      .update(agents)
      .set({ status: "paused" })
      .where(eq(agents.id, "ag_coach"));

    await expect(runTask("tsk_read", DEMO_USER_ID)).rejects.toBeInstanceOf(PolicyDenied);
  });

  it("rejects self-audit assignment at the database layer", async () => {
    await expect(
      db
        .update(tasks)
        .set({
          assigneeId: "ag_auditor",
          auditorId: "ag_auditor",
        })
        .where(eq(tasks.id, "tsk_research")),
    ).rejects.toThrow();
  });

  it("creates an approval instead of running an external action", async () => {
    const result = await runTask("tsk_booking", DEMO_USER_ID);
    expect(result).toMatchObject({ requiresApproval: true });

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_booking"));
    expect(task.status).toBe("awaiting_approval");

    const bookingRuns = await db
      .select()
      .from(runs)
      .where(eq(runs.taskId, "tsk_booking"));
    expect(bookingRuns).toHaveLength(0);
  });

  it("requires approval, then executes exactly once", async () => {
    await decideApproval("appr_booking", "approve", "test", DEMO_USER_ID);

    const result = await runTask("tsk_booking", DEMO_USER_ID);
    expect("runId" in result).toBe(true);

    await expect(runTask("tsk_booking", DEMO_USER_ID)).rejects.toBeInstanceOf(PolicyDenied);
  });

  it("rejects a repeated approval decision", async () => {
    await decideApproval("appr_booking", "approve", "test", DEMO_USER_ID);
    await expect(
      decideApproval("appr_booking", "approve", "test", DEMO_USER_ID),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("runs the reject → rework → accept loop", async () => {
    await expect(auditTask("tsk_quiz", DEMO_USER_ID)).resolves.toMatchObject({
      decision: "rejected",
    });
    await expect(runTask("tsk_quiz", DEMO_USER_ID)).resolves.toHaveProperty("runId");
    await expect(auditTask("tsk_quiz", DEMO_USER_ID)).resolves.toMatchObject({
      decision: "accepted",
    });

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_quiz"));
    expect(task.status).toBe("accepted");
    expect(task.acceptedAt).not.toBeNull();
    expect(task.acceptedAutonomyLevel).toBe(2);
  });
});
