import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_USER_ID } from "@/lib/demo";
import { loadAgentCard } from "@/server/readmodels";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

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

  it("returns null for an unknown or other-tenant agent", async () => {
    expect(await loadAgentCard(DEMO_USER_ID, "ag_missing")).toBeNull();
  });
});
