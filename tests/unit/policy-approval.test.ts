import { describe, expect, it } from "vitest";
import {
  decideRun,
  SEED_POLICY_CONFIG,
  type Actor,
  type PolicyConfig,
  type TaskPolicy,
} from "@/lib/domain/policy";

/**
 * Regression tests for the approval short-circuit.
 *
 * Approving a run used to return `allow` before grants, action-type and budget
 * checks ran, so a revoked grant, an `admin` action or an unknown action type
 * all executed once some approval existed. Approval must lift only the
 * approval requirement.
 */
const config: PolicyConfig = SEED_POLICY_CONFIG;

const actor = (overrides: Partial<Actor> = {}): Actor => ({
  id: "ag_agent",
  role: "coach",
  status: "active",
  lifecycleStage: "active",
  autonomyLevel: 2,
  trustScore: 80,
  successCount: 10,
  ...overrides,
});

const task = (overrides: Partial<TaskPolicy> = {}): TaskPolicy => ({
  assigneeId: "ag_agent",
  auditorId: "ag_auditor",
  actionType: "internal",
  resource: "task",
  requiresApproval: false,
  estimatedCostCents: 10,
  approvalThresholdCents: null,
  status: "assigned",
  ...overrides,
});

const budget = { limitCents: 10000, spentCents: 1000 };
const approved = { status: "approved", consumedAt: null };

describe("decideRun — approval scope", () => {
  it("still denies when the grant was revoked after the user approved", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 3 }),
      task: task({ actionType: "external_action" }),
      grants: [],
      budget,
      approval: approved,
      config,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("Missing grant");
  });

  it("still refuses an admin action even when approved", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 3 }),
      task: task({ actionType: "admin" }),
      grants: [{ resource: "*", scope: "write" }],
      budget,
      approval: approved,
      config,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("Admin actions");
  });

  it("still refuses an unknown action type even when approved", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 3 }),
      task: task({ actionType: "teleport" }),
      grants: [{ resource: "*", scope: "write" }],
      budget,
      approval: approved,
      config,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("Unknown action type");
  });

  it("lifts the approval requirement of an otherwise allowed run", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 2 }),
      task: task({ actionType: "external_action", resource: "web" }),
      grants: [{ resource: "web", scope: "write" }],
      budget,
      approval: approved,
      config,
    });
    expect(decision.effect).toBe("allow");
    expect(decision.reason).toContain("approved by user");
  });

  it("refuses a second execution of a consumed approval", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 2 }),
      task: task({ actionType: "external_action", resource: "web" }),
      grants: [{ resource: "web", scope: "write" }],
      budget,
      approval: { status: "approved", consumedAt: new Date("2026-10-01") },
      config,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("already been consumed");
  });

  it("keeps a rejection blocking regardless of grants", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 3 }),
      task: task(),
      grants: [{ resource: "*", scope: "write" }],
      budget,
      approval: { status: "rejected", consumedAt: null },
      config,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("rejected");
  });

  it("waits while an approval is pending", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 2 }),
      task: task({ actionType: "external_action", resource: "web" }),
      grants: [{ resource: "web", scope: "write" }],
      budget,
      approval: { status: "pending", consumedAt: null },
      config,
    });
    expect(decision.effect).toBe("require_approval");
  });
});
