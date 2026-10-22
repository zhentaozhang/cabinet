import { describe, expect, it } from "vitest";
import { planTools } from "@/lib/domain/tool-plan";

const web = [{ resource: "web", scope: "read" }];

describe("planTools", () => {
  it("picks the first tool the agent is actually granted", () => {
    const plan = planTools({
      tools: ["web_search", "read_notes"],
      grants: [{ resource: "notes", scope: "read" }],
      actionType: "internal",
    });
    expect(plan.planned?.tool).toBe("read_notes");
    expect(plan.considered[0]).toEqual({
      tool: "web_search",
      accepted: false,
      reason: "missing_grant",
    });
  });

  it("prefers the agent's declared order", () => {
    const plan = planTools({
      tools: ["web_search", "web_fetch"],
      grants: web,
      actionType: "internal",
    });
    expect(plan.planned?.tool).toBe("web_search");
  });

  it("plans nothing when no grant matches", () => {
    const plan = planTools({
      tools: ["web_search"],
      grants: [],
      actionType: "internal",
    });
    expect(plan.planned).toBeNull();
    expect(plan.reason).toContain("permitted");
  });

  it("reports an unknown tool instead of passing it through", () => {
    const plan = planTools({
      tools: ["teleport"],
      grants: [{ resource: "*", scope: "write" }],
      actionType: "external_action",
    });
    expect(plan.planned).toBeNull();
    expect(plan.considered[0]?.reason).toBe("unknown_tool");
  });

  it("blocks execute tools on internal actions", () => {
    const plan = planTools({
      tools: ["sandbox_execute"],
      grants: [{ resource: "sandbox", scope: "write" }],
      actionType: "internal",
    });
    expect(plan.planned).toBeNull();
    expect(plan.considered[0]?.reason).toBe("needs_action");
  });

  it("allows execute tools once the action is real", () => {
    const plan = planTools({
      tools: ["sandbox_execute"],
      grants: [{ resource: "sandbox", scope: "write" }],
      actionType: "external_action",
    });
    expect(plan.planned?.tool).toBe("sandbox_execute");
  });

  it("does not let a read grant satisfy a write tool", () => {
    const plan = planTools({
      tools: ["write_task"],
      grants: [{ resource: "task", scope: "read" }],
      actionType: "internal",
    });
    expect(plan.planned).toBeNull();
    expect(plan.considered[0]?.reason).toBe("missing_grant");
  });

  it("accepts a wildcard grant", () => {
    const plan = planTools({
      tools: ["write_plan"],
      grants: [{ resource: "*", scope: "write" }],
      actionType: "internal",
    });
    expect(plan.planned?.tool).toBe("write_plan");
  });
});
