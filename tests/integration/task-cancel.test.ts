/**
 * Cancelling stops work; it does not erase it.
 *
 * These tests exist because "cancel" is the easiest place to quietly turn into
 * "delete": a cancelled task that dropped its artifacts would make a bad run
 * disappear from the audit trail.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { artifacts, auditEvents, evidence, runs, tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { cancelTask } from "@/server/services/commands/tasks/cancel";
import { markTaskDone } from "@/server/services/commands/tasks/done";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

async function readTask(id: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  return row;
}

describe("cancelling a task", () => {
  it("moves a planned task to cancelled and records why", async () => {
    await cancelTask("tsk_read", DEMO_USER_ID, "这周先不做");

    const task = await readTask("tsk_read");
    expect(task.status).toBe("cancelled");

    const audit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.target, "tsk_read"));
    const cancel = audit.find((row) => row.action === "task.cancel");
    expect(cancel).toBeDefined();
    expect((cancel?.after as { reason?: string } | null)?.reason).toBe("这周先不做");
  });

  it("keeps the artifacts and evidence that already exist", async () => {
    // Money and work already spent must survive the cancellation: this is the
    // whole difference between "cancel" and "delete".
    await db
      .update(tasks)
      .set({ status: "planned" })
      .where(eq(tasks.id, "tsk_research"));
    const [run] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.taskId, "tsk_research"))
      .limit(1);
    await db.insert(artifacts).values({
      id: "art_cancel_test",
      taskId: "tsk_research",
      runId: run?.id ?? null,
      type: "markdown",
      title: "取消前的产物",
      content: "保留我",
    });
    await db.insert(evidence).values({
      id: "evd_cancel_test",
      userId: DEMO_USER_ID,
      taskId: "tsk_research",
      runId: run?.id ?? null,
      kind: "web_page",
      url: "https://example.org/keep",
      title: "保留我的来源",
      quote: "取消不该删掉证据。",
      provider: "brave",
      contentHash: "a".repeat(64),
      retrievedAt: new Date(),
    });

    await cancelTask("tsk_research", DEMO_USER_ID);

    expect((await readTask("tsk_research")).status).toBe("cancelled");
    const keptArtifacts = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, "art_cancel_test"));
    const keptEvidence = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, "evd_cancel_test"));
    expect(keptArtifacts).toHaveLength(1);
    expect(keptEvidence).toHaveLength(1);
  });

  it("refuses to cancel a finished record", async () => {
    // accepted → done is the terminal path; nothing here may be undone.
    const [accepted] = await db
      .update(tasks)
      .set({ status: "accepted" })
      .where(eq(tasks.id, "tsk_read"))
      .returning();
    await markTaskDone(accepted.id, DEMO_USER_ID);

    await expect(cancelTask("tsk_read", DEMO_USER_ID)).rejects.toThrow(/已完成/);
    expect((await readTask("tsk_read")).status).toBe("done");
  });

  it("refuses to cancel a task that is mid-run", async () => {
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, "tsk_read"));
    await expect(cancelTask("tsk_read", DEMO_USER_ID)).rejects.toThrow(/不能中途取消/);
  });

  it("cannot cancel someone else's task", async () => {
    await expect(cancelTask("tsk_read", "usr_other")).rejects.toThrow(/not found/i);
  });
});
