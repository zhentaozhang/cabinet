import { describe, expect, it } from "vitest";
import {
  decideAudit,
  decideRun,
  decideUpgrade,
  SEED_POLICY_CONFIG,
  type Actor,
  type PolicyConfig,
  type TaskPolicy,
} from "@/lib/domain/policy";

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

const grants = [{ resource: "task", scope: "execute" }];

const budget = { limitCents: 10000, spentCents: 1000 };

describe("decideRun", () => {
  it("denies paused agents", () => {
    const decision = decideRun({
      actor: actor({ status: "paused" }),
      task: task(),
      grants,
      budget,
      approval: null,
      config,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("paused");
  });

  it("denies agents in shadowing lifecycle", () => {
    const decision = decideRun({
      actor: actor({ lifecycleStage: "shadowing" }),
      task: task(),
      grants,
      budget,
      approval: null,
      config,
    });
    expect(decision.effect).toBe("deny");
  });

  it("denies a practice-passed apprentice even with a task grant", () => {
    // 转正门槛要的是「练习之后」的真实审计样本，而这里的生命周期判定在授权检查
    // 之前就把学徒拒了：它跑不出一次 live 运行，样本、成功任务和信任分就永远不动。
    // 学徒模板的默认授权还只有 task:read，但先命中 lifecycle 这段。
    const decision = decideRun({
      actor: actor({ lifecycleStage: "practice_passed" }),
      task: task(),
      grants: [{ resource: "task", scope: "read" }],
      budget,
      approval: { status: "approved", consumedAt: null },
      config,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("practice_passed");
  });

  it("denies non-assignee execution", () => {
    const decision = decideRun({
      actor: actor(),
      task: task({ assigneeId: "ag_other" }),
      grants,
      budget,
      approval: null,
      config,
    });
    expect(decision.effect).toBe("deny");
  });

  it("denies the auditor from executing its own audited task", () => {
    const decision = decideRun({
      actor: actor({ role: "auditor" }),
      task: task({ auditorId: "ag_agent" }),
      grants,
      budget,
      approval: null,
      config,
    });
    expect(decision.effect).toBe("deny");
  });

  it("denies when the grant is missing", () => {
    const decision = decideRun({
      actor: actor(),
      task: task(),
      grants: [],
      budget,
      approval: null,
      config,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("Missing grant");
  });

  it("suggests internal writes at L1", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 1 }),
      task: task(),
      grants,
      budget,
      approval: null,
      config,
    });
    expect(decision.effect).toBe("suggest");
  });

  it("allows internal writes at L2", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 2 }),
      task: task(),
      grants,
      budget,
      approval: null,
      config,
    });
    expect(decision.effect).toBe("allow");
  });

  it("suggests external actions at L1", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 1 }),
      task: task({ actionType: "external" }),
      grants,
      budget,
      approval: null,
      config,
    });
    expect(decision.effect).toBe("suggest");
  });

  it("requires approval for external actions at L2", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 2 }),
      task: task({ actionType: "external" }),
      grants,
      budget,
      approval: null,
      config,
    });
    expect(decision.effect).toBe("require_approval");
  });

  it("allows external actions at L3 within budget", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 3 }),
      task: task({ actionType: "external", estimatedCostCents: 10 }),
      grants,
      budget,
      approval: null,
      config,
    });
    expect(decision.effect).toBe("allow");
  });

  it("denies spend at L1", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 1 }),
      task: task({ actionType: "spend" }),
      grants,
      budget,
      approval: null,
      config,
    });
    expect(decision.effect).toBe("deny");
  });

  it("requires approval for spend at L2", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 2 }),
      task: task({ actionType: "spend" }),
      grants,
      budget,
      approval: null,
      config,
    });
    expect(decision.effect).toBe("require_approval");
  });

  it("allows spend at L3 below threshold", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 3 }),
      task: task({
        actionType: "spend",
        estimatedCostCents: 1000,
        approvalThresholdCents: 5000,
      }),
      grants,
      budget,
      approval: null,
      config,
    });
    expect(decision.effect).toBe("allow");
  });

  it("requires approval for spend at L3 above threshold", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 3 }),
      task: task({
        actionType: "spend",
        estimatedCostCents: 6000,
        approvalThresholdCents: 5000,
      }),
      grants,
      budget,
      approval: null,
      config,
    });
    expect(decision.effect).toBe("require_approval");
  });

  it("requires approval when estimated spend exceeds budget", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 2 }),
      task: task({ actionType: "spend", estimatedCostCents: 9500 }),
      grants,
      budget: { limitCents: 10000, spentCents: 1000 },
      approval: null,
      config,
    });
    expect(decision.effect).toBe("require_approval");
  });

  it("allows execution when an unconsumed approval exists", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 1 }),
      task: task({ actionType: "external" }),
      grants,
      budget,
      approval: { status: "approved", consumedAt: null },
      config,
    });
    expect(decision.effect).toBe("allow");
  });

  it("denies a consumed approval", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 1 }),
      task: task({ actionType: "external" }),
      grants,
      budget,
      approval: { status: "approved", consumedAt: new Date() },
      config,
    });
    expect(decision.effect).toBe("deny");
  });

  it("requires approval when one is already pending", () => {
    const decision = decideRun({
      actor: actor({ autonomyLevel: 2 }),
      task: task({ actionType: "external" }),
      grants,
      budget,
      approval: { status: "pending", consumedAt: null },
      config,
    });
    expect(decision.effect).toBe("require_approval");
  });

  it("denies unknown action types", () => {
    const decision = decideRun({
      actor: actor(),
      task: task({ actionType: "teleport" }),
      grants,
      budget,
      approval: null,
      config,
    });
    expect(decision.effect).toBe("deny");
  });
});

describe("decideAudit", () => {
  const auditor = actor({ id: "ag_auditor", role: "auditor", autonomyLevel: 2 });
  const auditTask = task({
    assigneeId: "ag_coach",
    auditorId: "ag_auditor",
    status: "submitted",
  });

  it("allows the assigned auditor", () => {
    expect(decideAudit({ actor: auditor, task: auditTask }).effect).toBe(
      "allow",
    );
  });

  it("denies non-auditors", () => {
    expect(
      decideAudit({ actor: actor({ role: "coach" }), task: auditTask }).effect,
    ).toBe("deny");
  });

  it("denies self-audit", () => {
    const selfTask = task({
      assigneeId: "ag_auditor",
      auditorId: "ag_auditor",
      status: "submitted",
    });
    expect(decideAudit({ actor: auditor, task: selfTask }).effect).toBe("deny");
  });

  it("denies a different auditor", () => {
    expect(
      decideAudit({
        actor: actor({ id: "ag_other", role: "auditor" }),
        task: auditTask,
      }).effect,
    ).toBe("deny");
  });

  it("denies unsubmitted tasks", () => {
    expect(
      decideAudit({
        actor: auditor,
        task: task({ ...auditTask, status: "running" }),
      }).effect,
    ).toBe("deny");
  });
});

describe("decideUpgrade", () => {
  it("allows upgrade when all thresholds are met", () => {
    const decision = decideUpgrade({
      actor: actor({ autonomyLevel: 2, trustScore: 80, successCount: 10 }),
      targetLevel: 3,
      auditPassRate: 0.95,
      auditSamples: 5,
      config,
    });
    expect(decision.effect).toBe("allow");
  });

  it("denies below trust threshold", () => {
    const decision = decideUpgrade({
      actor: actor({ trustScore: 50 }),
      targetLevel: 3,
      auditPassRate: 1,
      auditSamples: 5,
      config,
    });
    expect(decision.effect).toBe("deny");
  });

  it("denies below success threshold", () => {
    const decision = decideUpgrade({
      actor: actor({ successCount: 1 }),
      targetLevel: 3,
      auditPassRate: 1,
      auditSamples: 5,
      config,
    });
    expect(decision.effect).toBe("deny");
  });

  it("denies below audit pass rate", () => {
    const decision = decideUpgrade({
      actor: actor({ autonomyLevel: 1 }),
      targetLevel: 2,
      auditPassRate: 0.5,
      auditSamples: 5,
      config,
    });
    expect(decision.effect).toBe("deny");
  });

  it("denies L4 in this MVP", () => {
    const decision = decideUpgrade({
      actor: actor(),
      targetLevel: 4,
      auditPassRate: 1,
      auditSamples: 5,
      config,
    });
    expect(decision.effect).toBe("deny");
  });

  it("allows downgrade", () => {
    const decision = decideUpgrade({
      actor: actor({ autonomyLevel: 3 }),
      targetLevel: 1,
      auditPassRate: 0,
      auditSamples: 0,
      config,
    });
    expect(decision.effect).toBe("allow");
  });
});
