import { and, count, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { memories, tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { getAgentData } from "@/server/services/queries/agent";
import { resetDb } from "../helpers/db";

const AGENT_ID = "ag_coach";

/** How many memories this Agent really has, straight from the table. */
async function trueCount(): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(memories)
    .where(
      and(eq(memories.agentId, AGENT_ID), eq(memories.userId, DEMO_USER_ID)),
    );
  return Number(row.total);
}

async function addMemories(prefix: string, howMany: number, salience: number) {
  await db.insert(memories).values(
    Array.from({ length: howMany }, (_, index) => ({
      id: `${prefix}_${String(index).padStart(2, "0")}`,
      userId: DEMO_USER_ID,
      agentId: AGENT_ID,
      type: "semantic",
      domain: "learning",
      content: `${prefix} 记下的第 ${index + 1} 件事`,
      confidence: 0.8,
      salience,
      evidence: [],
    })),
  );
}

describe("agent detail: how many memories the agent has", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("counts every memory, not just the ones the card can show", async () => {
    await addMemories("mem_card", 12, 0.99);

    const data = await getAgentData(AGENT_ID, DEMO_USER_ID);
    if (!data) throw new Error("Expected the seeded Agent to exist.");

    // The card only has room for eight (and shows five of them).
    expect(data.memories.length).toBe(8);
    expect(data.memoryTotal).toBe(await trueCount());
    expect(data.memoryTotal).toBeGreaterThan(data.memories.length);
  });

  it("breaks salience ties by id so the card does not shuffle", async () => {
    await addMemories("mem_tie", 2, 0.77);

    const data = await getAgentData(AGENT_ID, DEMO_USER_ID);
    if (!data) throw new Error("Expected the seeded Agent to exist.");
    const tied = data.memories
      .filter((memory) => memory.id.startsWith("mem_tie_"))
      .map((memory) => memory.id);

    expect(tied).toEqual(["mem_tie_01", "mem_tie_00"]);
  });
});

describe("agent detail: the Tasks tile counts what the Agent carried", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("reports every task, not the eight-row window under it", async () => {
    const later = new Date(Date.now() + 60_000);
    await db.insert(tasks).values(
      Array.from({ length: 12 }, (_, index) => ({
        id: "tsk_tile_" + String(index).padStart(2, "0"),
        userId: DEMO_USER_ID,
        goalId: "goal_rag",
        title: "第 " + (index + 1) + " 件经手的事",
        description: "填满详情页窗口，看瓦片是否还在数这八条。",
        acceptanceCriteria: "能被列出来", 
        type: "research",
        status: "done",
        assigneeId: AGENT_ID,
        auditorId: "ag_auditor",
        updatedAt: later,
      })),
    );

    const [row] = await db
      .select({ total: count() })
      .from(tasks)
      .where(and(eq(tasks.assigneeId, AGENT_ID), eq(tasks.userId, DEMO_USER_ID)));
    const data = await getAgentData(AGENT_ID, DEMO_USER_ID);
    if (!data) throw new Error("Expected the seeded Agent to exist.");

    // The list below the tile is capped at eight; the tile sits next to lifetime
    // pass/reject counts, so it must be the lifetime number too.
    expect(data.tasks.length).toBe(8);
    expect(data.taskTotal).toBe(Number(row.total));
    expect(data.taskTotal).toBeGreaterThan(data.tasks.length);
  });
});
