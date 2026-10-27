import { describe, expect, it } from "vitest";

import {
  decideRun,
  SEED_POLICY_CONFIG,
  type Actor,
  type Grant,
  type PolicyConfig,
  type TaskPolicy,
} from "@/lib/domain/policy";
import {
  explainRunPolicy,
  type PolicyExplainInput,
} from "@/lib/domain/policy-explain";
import type { StandingGrant } from "@/lib/domain/standing-grants";

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

const grants: Grant[] = [{ resource: "task", scope: "execute" }];
const budget = { limitCents: 10000, spentCents: 1000 };

function explain(overrides: Partial<PolicyExplainInput> = {}) {
  const input: PolicyExplainInput = {
    actor: actor(),
    task: task(),
    grants,
    budget,
    approval: null,
    config,
    ...overrides,
  };
  return { input, explained: explainRunPolicy(input) };
}

function standing(overrides: Partial<StandingGrant> = {}): StandingGrant {
  return {
    id: "agr_standing",
    resource: "task",
    action: "external_action",
    createdByApprovalId: "apr_1",
    expiresAt: null,
    maxCents: null,
    maxRuns: 3,
    useCount: 1,
    revokedAt: null,
    ...overrides,
  };
}

/**
 * 预演面板的文案就是这张表：四种 effect 各有一例，断言的是「用户看完这句话
 * 就知道下一步该点什么」，不是复述 English reason。
 */
describe("explainRunPolicy", () => {
  it("allow：只读内部动作直接放行，且没有要补的东西", () => {
    const { explained } = explain({ task: task({ actionType: "internal_read" }) });
    expect(explained.effect).toBe("allow");
    expect(explained.rule).toBe("internal_read");
    expect(explained.missing).toEqual([]);
    expect(explained.override).toBeNull();
  });

  it("suggest：L1 的内部写只能建议，缺的是把自治等级提到 L2", () => {
    const { explained } = explain({ actor: actor({ autonomyLevel: 1 }) });
    expect(explained.effect).toBe("suggest");
    expect(explained.rule).toBe("internal_write");
    expect(explained.missing.join()).toContain("L2");
  });

  it("require_approval：L2 外部动作要一次审批，缺的是这一次批准", () => {
    const { explained } = explain({ task: task({ actionType: "external" }) });
    expect(explained.effect).toBe("require_approval");
    expect(explained.rule).toBe("external_action");
    expect(explained.missing.join()).toContain("批准");
  });

  it("deny：没有授权时点名缺哪条授权，而不是只说被拒绝", () => {
    const { explained } = explain({ task: task({ resource: "calendar" }) });
    expect(explained.effect).toBe("deny");
    expect(explained.rule).toBe("missing_grant");
    expect(explained.missing[0]).toContain("calendar");
    expect(explained.missing[0]).toContain("write");
  });

  it("require_approval：超预算时算出差额，并说清批准解决不了", () => {
    // 超预算这条检查在 policy.ts:454 只有 level >= 3 才走得到（L1/L2 的动作
    // 在前面就 return 了），所以这里用 L3 + 外部动作，才真的命中所测分支。
    const { explained } = explain({
      actor: actor({ autonomyLevel: 3 }),
      task: task({ actionType: "external", estimatedCostCents: 1000 }),
      budget: { limitCents: 10000, spentCents: 9500 },
    });
    expect(explained.effect).toBe("require_approval");
    expect(explained.rule).toBe("budget_exceeded");
    expect(explained.missing.join()).toContain("¥5.00");
    expect(explained.missing.join()).toContain("预算");
  });

  it("deny：已消耗的审批不能再放行一次", () => {
    const { explained } = explain({
      task: task({ actionType: "external" }),
      approval: { status: "approved", consumedAt: new Date("2026-01-01T00:00:00Z") },
    });
    expect(explained.effect).toBe("deny");
    expect(explained.rule).toBe("approval_consumed");
    expect(explained.missing.join()).toContain("审批");
  });

  it("allow：这次已批准时，命中规则仍是原来那条，只是被审批覆盖", () => {
    const { explained } = explain({
      task: task({ actionType: "external" }),
      approval: { status: "approved", consumedAt: null },
    });
    expect(explained.effect).toBe("allow");
    expect(explained.rule).toBe("external_action");
    expect(explained.override).toBe("approval");
    expect(explained.missing).toEqual([]);
  });

  it("allow：常驻授权沿用此前的批准，理由里带着授权原文", () => {
    const { explained } = explain({
      task: task({ actionType: "external" }),
      standingGrants: [standing()],
    });
    expect(explained.effect).toBe("allow");
    expect(explained.rule).toBe("external_action");
    expect(explained.override).toBe("standing_grant");
    expect(explained.reason).toContain("沿用你此前的批准");
    expect(explained.missing).toEqual([]);
  });

  it("四种 effect 与 decideRun 同输入同结果（解释器不另写一套策略）", () => {
    const inputs: PolicyExplainInput[] = [
      {
        actor: actor({ autonomyLevel: 1 }),
        task: task({ actionType: "internal_read" }),
        grants,
        budget,
        approval: null,
        config,
      },
      {
        actor: actor(),
        task: task({ actionType: "external" }),
        grants,
        budget,
        approval: null,
        config,
      },
      {
        actor: actor({ status: "paused" }),
        task: task(),
        grants,
        budget,
        approval: null,
        config,
      },
      {
        actor: actor(),
        task: task({ actionType: "spend", estimatedCostCents: 25000 }),
        grants,
        budget: { limitCents: 60000, spentCents: 0 },
        approval: null,
        config,
      },
      {
        actor: actor({ autonomyLevel: 3 }),
        task: task({ actionType: "spend", estimatedCostCents: 25000 }),
        grants,
        budget: { limitCents: 60000, spentCents: 0 },
        approval: { status: "approved", consumedAt: null },
        config,
      },
      {
        actor: actor(),
        task: task({ actionType: "external", auditorId: "ag_agent" }),
        grants,
        budget,
        approval: null,
        config,
      },
      {
        actor: actor(),
        task: task({ actionType: "admin" }),
        grants,
        budget,
        approval: null,
        config,
      },
      {
        actor: actor({ autonomyLevel: 1 }),
        task: task({ actionType: "internal_write", requiresApproval: true }),
        grants,
        budget,
        approval: null,
        config,
      },
    ];

    for (const input of inputs) {
      const decision = decideRun(input);
      const explained = explainRunPolicy(input);
      // effect 永远来自 decideRun；解释器只负责把 reason 翻译成人话。
      expect(explained.effect).toBe(decision.effect);
      expect(explained.policyReason).toBe(decision.reason);
      if (decision.effect === "allow") expect(explained.missing).toEqual([]);
    }
  });
});
