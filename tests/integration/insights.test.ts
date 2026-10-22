import { DEMO_USER_ID } from "@/lib/demo";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memories, tasks } from "@/lib/db/schema";
import { applyInsight } from "@/lib/engine";
import { ConflictError } from "@/lib/domain/errors";
import { verifyAuditChain } from "@/lib/audit";
import { retrieveMemories } from "@/lib/memory/retrieval";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("insight state guards", () => {
  it("accepts an insight once and rolls it back exactly", async () => {
    await applyInsight("ins_split", "accept", DEMO_USER_ID);

    const [afterAccept] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_read"));
    expect(afterAccept.estimateMin).toBe(25);

    const created = await db
      .select()
      .from(memories)
      .where(eq(memories.sourceEventId, "ins_split"));
    expect(created).toHaveLength(1);

    await expect(applyInsight("ins_split", "accept", DEMO_USER_ID)).rejects.toBeInstanceOf(
      ConflictError,
    );

    await applyInsight("ins_split", "rollback", DEMO_USER_ID);
    const [afterRollback] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_read"));
    expect(afterRollback.estimateMin).toBe(45);
  });

  it("refuses to roll back an insight that was never applied", async () => {
    await expect(
      applyInsight("ins_split", "rollback", DEMO_USER_ID),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("invalidates the insight's memory when the insight is rolled back", async () => {
    await applyInsight("ins_split", "accept", DEMO_USER_ID);

    const [accepted] = await db
      .select()
      .from(memories)
      .where(eq(memories.sourceEventId, "ins_split"));
    expect(accepted.status).toBe("active");
    expect(accepted.validTo).toBeNull();

    const visibleBefore = await retrieveMemories(DEMO_USER_ID, "RAG 阅读", {
      limit: 100,
    });
    expect(visibleBefore.some((memory) => memory.id === accepted.id)).toBe(true);

    await applyInsight("ins_split", "rollback", DEMO_USER_ID);

    const [rolledBack] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, accepted.id));
    expect(rolledBack.status).toBe("rolled_back");
    expect(rolledBack.validTo).not.toBeNull();

    const visibleAfter = await retrieveMemories(DEMO_USER_ID, "RAG 阅读", {
      limit: 100,
    });
    expect(visibleAfter.some((memory) => memory.id === accepted.id)).toBe(false);

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_read"));
    expect(task.estimateMin).toBe(45);

    const chain = await verifyAuditChain(DEMO_USER_ID);
    expect(chain.ok).toBe(true);
  });

  it("refuses to reject an applied insight", async () => {
    await applyInsight("ins_split", "accept", DEMO_USER_ID);
    await expect(applyInsight("ins_split", "reject", DEMO_USER_ID)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});
