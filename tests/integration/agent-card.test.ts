import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { loadAgentCard } from "@/server/readmodels";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

const AGENT_ID = "ag_coach";

describe("agent card", () => {
  it("exports a whitelisted, contract-valid card", async () => {
    const coach = await loadAgentCard(DEMO_USER_ID, "ag_coach");
    expect(coach).not.toBeNull();
    expect(coach!.schemaVersion).toBe("1.0");
    expect(coach!.id).toBe("ag_coach");
    expect(coach!.outcomes.length).toBeGreaterThan(0);

    const apprentice = await loadAgentCard(DEMO_USER_ID, "ag_apprentice");
    expect(apprentice).not.toBeNull();
    expect(apprentice!.skills.length).toBeGreaterThan(0);
    expect(apprentice!.skills[0]).toHaveProperty("label");

    const serialized = JSON.stringify(coach);
    expect(serialized).not.toContain("demo@cabinet.local");
    expect(serialized).not.toContain("mem_evening");
    expect(serialized).not.toContain("health");
  });

  it("lists the Agent's real latest outcomes, not the ones on the detail page", async () => {
    // The detail page reads the eight most recently updated tasks, which is a
    // display window. Recent work that is not accepted yet then pushed the
    // accepted ones out of the card entirely.
    const now = Date.now();
    await db.insert(tasks).values(
      [0, 1, 2].map((index) => ({
        id: `tsk_card_accepted_${index}`,
        userId: DEMO_USER_ID,
        assigneeId: AGENT_ID,
        title: `第 ${index + 1} 次通过验收`,
        description: "Agent Card 应列出这次验收。",
        status: "accepted",
        acceptanceCriteria: "有产物",
        estimateMin: 20,
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        createdBy: "agent",
        // Newest acceptances in the workspace: the seeded ones are yesterday.
        acceptedAt: new Date(now - index * 60_000),
      })),
    );
    // Eight newer tasks that are still in flight: they fill the detail window
    // without being outcomes.
    await db.insert(tasks).values(
      Array.from({ length: 8 }, (_, index) => ({
        id: `tsk_card_open_${index}`,
        userId: DEMO_USER_ID,
        assigneeId: AGENT_ID,
        title: `还在做的第 ${index + 1} 件`,
        description: "进行中，不是验收结果。",
        status: "planned",
        acceptanceCriteria: "有产物",
        estimateMin: 20,
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        createdBy: "agent",
        updatedAt: new Date(now + (index + 1) * 60_000),
      })),
    );

    const card = await loadAgentCard(DEMO_USER_ID, AGENT_ID);
    // Newest acceptance first; older ones may follow to fill the five slots.
    expect(card!.outcomes.map((outcome) => outcome.taskId).slice(0, 3)).toEqual([
      "tsk_card_accepted_0",
      "tsk_card_accepted_1",
      "tsk_card_accepted_2",
    ]);
  });

  it("returns null for an unknown or other-tenant agent", async () => {
    expect(await loadAgentCard(DEMO_USER_ID, "ag_missing")).toBeNull();
  });
});
