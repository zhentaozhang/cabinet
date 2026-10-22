import { describe, expect, it } from "vitest";
import {
  agentUpdateSchema,
  checkinSchema,
  insightActionSchema,
  taskCreateSchema,
} from "@/lib/validation/schemas";

describe("validation schemas", () => {
  it("rejects self-audit task creation", () => {
    const result = taskCreateSchema.safeParse({
      title: "test",
      description: "desc",
      assigneeId: "ag_a",
      auditorId: "ag_a",
      acceptanceCriteria: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("fills task defaults", () => {
    const result = taskCreateSchema.parse({
      title: "test",
      description: "desc",
      assigneeId: "ag_a",
      auditorId: "ag_b",
      acceptanceCriteria: "ok",
    });
    expect(result.actionType).toBe("internal");
    expect(result.resource).toBe("task");
    expect(result.estimateMin).toBe(25);
    expect(result.estimatedCostCents).toBe(0);
  });

  it("rejects an empty agent update", () => {
    expect(agentUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a short charter", () => {
    expect(
      agentUpdateSchema.safeParse({ charter: "too short" }).success,
    ).toBe(false);
  });

  it("accepts a valid agent update", () => {
    const result = agentUpdateSchema.safeParse({
      status: "paused",
      budgetCents: 2000,
    });
    expect(result.success).toBe(true);
  });

  it("defaults check-in fields", () => {
    const result = checkinSchema.parse({});
    expect(result.energy).toBe(3);
    expect(result.mood).toBe(3);
    expect(result.completed).toEqual([]);
    expect(result.note).toBe("");
  });

  it("rejects unknown insight actions", () => {
    expect(insightActionSchema.safeParse({ action: "delete" }).success).toBe(
      false,
    );
  });
});
