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

/**
 * 规则身份来自 decideRun 的措辞（policy-explain.ts 用正则回溯理由文案），
 * 所以措辞一改就可能静默退化成 "unrecognized" —— 用户看到的就是
 * 「这条理由还没有对应的中文解释」。这张场景矩阵把它钉住：每个 decideRun
 * 能产出的理由都必须落到具体 rule，反过来每个 rule 也必须有场景能命中，
 * 这样删映射或多写一条映射都会变红。
 */
describe("规则表覆盖 decideRun 的每一种理由", () => {
  const scenario = (
    name: string,
    overrides: Partial<PolicyExplainInput>,
  ): { name: string; input: PolicyExplainInput } => ({
    name,
    input: {
      actor: actor(),
      task: task(),
      grants,
      budget,
      approval: null,
      config,
      ...overrides,
    },
  });

  const scenarios = [
    scenario("agent_not_active", { actor: actor({ status: "paused" }) }),
    scenario("agent_lifecycle", {
      actor: actor({ lifecycleStage: "onboarding" }),
    }),
    scenario("not_assignee", { task: task({ assigneeId: "ag_other" }) }),
    scenario("auditor_cannot_run", { task: task({ auditorId: "ag_agent" }) }),
    scenario("approval_rejected", {
      approval: { status: "rejected", consumedAt: null },
    }),
    scenario("approval_pending", {
      approval: { status: "pending", consumedAt: null },
    }),
    // gate() 只被「本该要审批」的分支调用：等级够高时 approval 根本不会被读到，
    // 所以这里必须同时造出需要审批的动作，否则这条场景测的是别的东西。
    scenario("approval_consumed", {
      actor: actor({ autonomyLevel: 2 }),
      task: task({ actionType: "external" }),
      approval: { status: "approved", consumedAt: new Date("2026-01-01T00:00:00Z") },
    }),
    scenario("unknown_action", { task: task({ actionType: "teleport" }) }),
    scenario("missing_grant", { grants: [] }),
    scenario("admin_action", { task: task({ actionType: "admin" }) }),
    scenario("audit_action", { task: task({ actionType: "audit" }) }),
    scenario("internal_read", { task: task({ actionType: "internal_read" }) }),
    scenario("internal_write_allow", {}),
    scenario("internal_write_suggest", { actor: actor({ autonomyLevel: 1 }) }),
    scenario("external_action_suggest", {
      actor: actor({ autonomyLevel: 1 }),
      task: task({ actionType: "external" }),
    }),
    scenario("external_action_approval", {
      actor: actor({ autonomyLevel: 2 }),
      task: task({ actionType: "external" }),
    }),
    scenario("spend_l1", {
      actor: actor({ autonomyLevel: 1 }),
      task: task({ actionType: "spend" }),
    }),
    scenario("spend_l2", {
      actor: actor({ autonomyLevel: 2 }),
      task: task({ actionType: "spend" }),
    }),
    scenario("spend_threshold", {
      actor: actor({ autonomyLevel: 3 }),
      task: task({ actionType: "spend", estimatedCostCents: 25000 }),
    }),
    scenario("requires_approval", {
      actor: actor({ autonomyLevel: 3 }),
      task: task({ actionType: "external", requiresApproval: true }),
    }),
    scenario("budget_exceeded", {
      actor: actor({ autonomyLevel: 3 }),
      task: task({ actionType: "spend" }),
      budget: { limitCents: 100_00, spentCents: 9_995 },
    }),
    scenario("default_allow", {
      actor: actor({ autonomyLevel: 3 }),
      task: task({ actionType: "external", estimatedCostCents: 0 }),
    }),
    // 覆盖层不是另一条规则：命中规则不变，只是 effect 被抬成 allow。
    scenario("standing_grant", {
      actor: actor({ autonomyLevel: 2 }),
      task: task({ actionType: "external" }),
      standingGrants: [standing()],
    }),
    scenario("approval_override", {
      actor: actor({ autonomyLevel: 3 }),
      task: task({ actionType: "external", requiresApproval: true }),
      approval: { status: "approved", consumedAt: null },
    }),
  ];

  it("没有一条理由退化成 unrecognized", () => {
    const broken = scenarios
      .map((entry) => ({
        name: entry.name,
        rule: explainRunPolicy(entry.input).rule,
        reason: decideRun(entry.input).reason,
      }))
      .filter((entry) => entry.rule === "unrecognized")
      .map((entry) => `${entry.name}: ${entry.reason}`);
    expect(broken).toEqual([]);
  });

  it("每个规则身份都有场景能命中", () => {
    const expected = [
      "admin_action",
      "agent_lifecycle",
      "agent_not_active",
      "approval_consumed",
      "approval_pending",
      "approval_rejected",
      "audit_action",
      "auditor_cannot_run",
      "budget_exceeded",
      "default_allow",
      "external_action",
      "internal_read",
      "internal_write",
      "missing_grant",
      "not_assignee",
      "requires_approval",
      "spend",
      "spend_threshold",
      "unknown_action",
    ];
    const produced = scenarios.map((entry) => explainRunPolicy(entry.input).rule);
    expect([...new Set(produced)].sort()).toEqual(expected);
  });
});

