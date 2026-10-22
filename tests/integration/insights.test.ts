import { DEMO_USER_ID } from "@/lib/demo";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memories, tasks } from "@/lib/db/schema";
import { applyInsight } from "@/lib/engine";
import { ConflictError } from "@/lib/domain/errors";
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

  it("refuses to reject an applied insight", async () => {
    await applyInsight("ins_split", "accept", DEMO_USER_ID);
    await expect(applyInsight("ins_split", "reject", DEMO_USER_ID)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});
