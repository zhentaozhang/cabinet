import { and, eq, isNull, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { memories } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { getMemoryData } from "@/server/services/queries/memory";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("memory page stats describe the library, not the page", () => {
  it("counts conflicts and averages confidence over every current memory", async () => {
    // The conflict is the oldest row, so it sorts onto the last page: the card
    // used to tally only the rows on screen and print "0 待解决矛盾" while the
    // Memories tile next to it counted every row.
    await db.insert(memories).values({
      id: "mem_conflict_far",
      userId: DEMO_USER_ID,
      type: "semantic",
      domain: "learning",
      content: "旧结论与新的自测相矛盾。",
      confidence: 0.2,
      salience: 0.1,
      evidence: [{ label: "昨天的自测", ref: "chk_yesterday", quote: "回忆分 0.4" }],
      status: "conflicted",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await db.insert(memories).values(
      Array.from({ length: 30 }, (_, index) => ({
        id: "mem_fresh_" + String(index).padStart(2, "0"),
        userId: DEMO_USER_ID,
        type: "semantic" as const,
        domain: "learning",
        content: "第 " + index + " 条新记忆。",
        confidence: 0.9,
        salience: 0.3,
        evidence: [{ label: "昨天的自测", ref: "chk_yesterday", quote: "回忆分 0.4" }],
        createdAt: new Date(Date.UTC(2026, 9, 20, 0, index, 0)),
      })),
    );

    // The oracle is the table itself, queried the same way the card is scoped.
    const [expected] = await db
      .select({
        conflicts: sql<number>`count(*) filter (where ${memories.status} = 'conflicted')`,
        avg: sql<number>`avg(${memories.confidence})`,
      })
      .from(memories)
      .where(and(eq(memories.userId, DEMO_USER_ID), isNull(memories.validTo)));

    const page = await getMemoryData(DEMO_USER_ID, undefined, "current", {
      limit: 5,
      offset: 0,
    });

    expect(page.memories).toHaveLength(5);
    expect(page.memories.some((memory) => memory.status === "conflicted")).toBe(false);
    expect(page.conflicts).toBe(Number(expected.conflicts));
    expect(page.conflicts).toBeGreaterThan(0);
    expect(page.avgConfidence).toBeCloseTo(Number(expected.avg), 5);
  });

  it("reports no average at all when the view is empty", async () => {
    const empty = await getMemoryData("usr_memstats_nobody");
    expect(empty.conflicts).toBe(0);
    expect(empty.avgConfidence).toBeNull();
  });
});
