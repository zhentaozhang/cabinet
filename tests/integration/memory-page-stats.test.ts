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
      // Production closes the rejected claim the moment it is contradicted
      // (`writeMemoryFact`: `validTo = now`), so a realistic fixture does too.
      validTo: new Date("2026-01-02T00:00:00.000Z"),
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

    // The oracle is the table itself: the average is scoped to the current tab
    // (a closed row is not a current belief), while conflicts are counted over
    // the whole library — production closes the rejected claim, so a conflict
    // never sits in the current tab and a scoped count could only ever read 0.
    const [expectedAvg] = await db
      .select({ avg: sql<number>`avg(${memories.confidence})` })
      .from(memories)
      .where(and(eq(memories.userId, DEMO_USER_ID), isNull(memories.validTo)));
    const [expectedConflicts] = await db
      .select({ conflicts: sql<number>`count(*)` })
      .from(memories)
      .where(
        and(
          eq(memories.userId, DEMO_USER_ID),
          eq(memories.status, "conflicted"),
        ),
      );

    const page = await getMemoryData(DEMO_USER_ID, undefined, "current", {
      limit: 5,
      offset: 0,
    });

    expect(page.memories).toHaveLength(5);
    expect(page.memories.some((memory) => memory.status === "conflicted")).toBe(false);
    expect(page.conflicts).toBe(Number(expectedConflicts.conflicts));
    expect(page.conflicts).toBeGreaterThan(0);
    expect(page.avgConfidence).toBeCloseTo(Number(expectedAvg.avg), 5);
  });

  it("reports no average at all when the view is empty", async () => {
    const empty = await getMemoryData("usr_memstats_nobody");
    expect(empty.conflicts).toBe(0);
    expect(empty.avgConfidence).toBeNull();
  });
  it("counts a conflict the way production writes it, even though it is closed", async () => {
    // writeMemoryFact 把被否掉的说法立刻关掉（validTo = now）并标 conflicted，
    // 所以这条永远不在「当前」这一栏里。按 tab 的过滤数冲突，这个格子就恒为 0，
    // 而内阁页按整张表统计，同一批数据会写「N 条自相矛盾，待你裁定」。
    await db.delete(memories).where(eq(memories.userId, DEMO_USER_ID));
    await db.insert(memories).values([
      {
        id: "mem_open_fact",
        userId: DEMO_USER_ID,
        type: "semantic",
        domain: "learning",
        content: "早上学习效率更高。",
        confidence: 0.9,
        salience: 0.3,
        evidence: [{ label: "本周打卡", ref: "chk_week", quote: "回忆分 0.8" }],
        sourceEventId: "chk_week",
      },
      {
        id: "mem_closed_conflict",
        userId: DEMO_USER_ID,
        type: "semantic",
        domain: "learning",
        content: "你偏好晚上学习。",
        confidence: 0.38,
        salience: 0.4,
        evidence: [{ label: "上周自述", ref: "chk_last", quote: "晚上安静" }],
        sourceEventId: "chk_last",
        status: "conflicted",
        validTo: new Date("2026-10-21T00:00:00.000Z"),
      },
    ]);

    const current = await getMemoryData(DEMO_USER_ID, undefined, "current");
    expect(current.memories.map((memory) => memory.id)).toEqual(["mem_open_fact"]);
    expect(current.conflicts).toBe(1);

    const history = await getMemoryData(DEMO_USER_ID, undefined, "history");
    expect(history.memories.map((memory) => memory.id)).toEqual([
      "mem_closed_conflict",
    ]);
    expect(history.conflicts).toBe(1);
  });
});
