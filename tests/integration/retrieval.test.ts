import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memories, steps, users } from "@/lib/db/schema";
import { retrieveMemories } from "@/lib/memory/retrieval";
import { runTask } from "@/server/services/engine";
import { DEMO_USER_ID } from "@/lib/demo";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("retrieveMemories", () => {
  it("retrieves the evening-energy memory for a matching query", async () => {
    const results = await retrieveMemories(DEMO_USER_ID, "晚上 运动", {
      limit: 3,
    });
    expect(results[0].content).toContain("晚上");
  });

  it("retrieves the rerank memory for a matching query", async () => {
    const results = await retrieveMemories(DEMO_USER_ID, "rerank", {
      limit: 3,
    });
    expect(results[0].content.toLowerCase()).toContain("rerank");
  });

  it("does not return another user's memories", async () => {
    await db.insert(users).values({
      id: "usr_memory_other",
      email: "memory-other@cabinet.local",
      name: "Other",
      emailVerified: true,
      updatedAt: new Date(),
    });
    await db.insert(memories).values({
      id: "mem_other_evening",
      userId: "usr_memory_other",
      agentId: null,
      type: "semantic",
      domain: "health",
      content: "晚上运动任务连续跳过。",
      confidence: 0.9,
      salience: 1,
      evidence: [],
    });

    const results = await retrieveMemories(DEMO_USER_ID, "晚上 运动", {
      limit: 20,
    });
    expect(results.some((memory) => memory.id === "mem_other_evening")).toBe(
      false,
    );
  });

  it("records the retrieval breakdown in the run context step", async () => {
    const result = await runTask("tsk_read", DEMO_USER_ID);
    const runId = "runId" in result ? result.runId : undefined;
    if (!runId) {
      throw new Error("Expected the task to run, not request approval.");
    }
    const [contextStep] = await db
      .select()
      .from(steps)
      .where(and(eq(steps.runId, runId), eq(steps.type, "context")));

    const output = contextStep.output as {
      retrieved?: Array<{ id: string; scores: { total: number } }>;
    };
    expect(output.retrieved?.length).toBeGreaterThan(0);
    expect(output.retrieved?.[0].scores.total).toBeGreaterThanOrEqual(0);
  });
});
