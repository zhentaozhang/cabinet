import { and, count, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { memories } from "@/lib/db/schema";
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
