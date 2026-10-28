import { describe, expect, it } from "vitest";
import {
  agentUpdateSchema,
  checkinSchema,
  insightActionSchema,
  setupSchema,
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

  it("rejects a spend task without a positive amount", () => {
    const base = {
      title: "buy",
      description: "desc",
      assigneeId: "ag_a",
      auditorId: "ag_b",
      acceptanceCriteria: "ok",
      actionType: "spend" as const,
    };
    expect(taskCreateSchema.safeParse(base).success).toBe(false);
    expect(
      taskCreateSchema.safeParse({ ...base, estimatedCostCents: 0 }).success,
    ).toBe(false);
    expect(
      taskCreateSchema.safeParse({ ...base, estimatedCostCents: -100 }).success,
    ).toBe(false);
  });

  it("accepts a spend task with a positive amount", () => {
    const result = taskCreateSchema.safeParse({
      title: "buy",
      description: "desc",
      assigneeId: "ag_a",
      auditorId: "ag_b",
      acceptanceCriteria: "ok",
      actionType: "spend",
      estimatedCostCents: 100,
    });
    expect(result.success).toBe(true);
  });

  it("defaults non-spend tasks to zero cost", () => {
    for (const actionType of ["internal", "external", "publish"] as const) {
      const result = taskCreateSchema.parse({
        title: "t",
        description: "d",
        assigneeId: "ag_a",
        auditorId: "ag_b",
        acceptanceCriteria: "ok",
        actionType,
      });
      expect(result.estimatedCostCents).toBe(0);
    }
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

  it("requires a first goal during setup", () => {
    expect(setupSchema.safeParse({ timezone: "UTC" }).success).toBe(false);
    expect(
      setupSchema.safeParse({
        timezone: "UTC",
        goal: {
          title: "学习",
          why: "why",
          target: "target",
          horizon: "6 weeks",
          domain: "learning",
        },
      }).success,
    ).toBe(true);
  });


  it("rejects a time zone Intl cannot format with", () => {
    const goal = {
      title: "学习",
      why: "why",
      target: "target",
      horizon: "6 weeks",
      domain: "learning",
    };
    // Every page renders timestamps through Intl with this zone, and setup is the
    // only place that writes `users.timezone` — an unusable value would leave a
    // workspace that throws on every page load with no screen to fix it.
    expect(
      () => new Intl.DateTimeFormat("en-US", { timeZone: "Mars/Phobos" }),
    ).toThrow(RangeError);
    expect(setupSchema.safeParse({ timezone: "Mars/Phobos", goal }).success).toBe(false);
    expect(setupSchema.safeParse({ timezone: "  ", goal }).success).toBe(false);
    expect(setupSchema.safeParse({ timezone: "Asia/Shanghai", goal }).success).toBe(true);
    expect(setupSchema.safeParse({ timezone: "UTC", goal }).success).toBe(true);
  });
  it("rejects unknown insight actions", () => {
    expect(insightActionSchema.safeParse({ action: "delete" }).success).toBe(
      false,
    );
  });
});
