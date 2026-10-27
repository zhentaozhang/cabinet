import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SEED_POLICY_CONFIG } from "@/lib/domain/policy";
import { buildPolicyInput } from "@/server/services/commands/tasks/run-context";

/**
 * 预演面板和真实执行共用这一份取数映射。这里钉住三件曾经各写一份、
 * 也已经分过叉的事：执行者取 assignee、同一批 grant 同时喂资源授权和
 * 常驻授权、预算来自周账本而不是 agents.spentCents。
 */
describe("调用方必须共用同一个 loader", () => {
  // 这份映射分过叉：预演面板曾经手写一遍 run.ts 的取数，靠一句注释提醒同步。
  // 边界测试管不到「同层复制」，所以这里直接读源码：两边都必须调 loader，
  // 任何一边重新手写策略输入都会让这条变红。
  const read = (path: string) => readFileSync(path, "utf8");
  const preview = read("src/app/api/tasks/[id]/policy-preview/route.ts");
  const run = read("src/server/services/commands/tasks/run.ts");

  it("预演与执行都调 loadRunContext", () => {
    expect(preview).toContain("loadRunContext");
    expect(run).toContain("loadRunContext");
  });

  it("没有任何一边重新手写策略输入", () => {
    expect(preview).not.toContain("decideRun(");
    expect(run).not.toContain("timeZone: timezone");
    expect(preview).not.toContain("standingGrants: grants.map");
  });
});

describe("buildPolicyInput", () => {
  const agent = {
    id: "ag_coach",
    userId: "usr_1",
    role: "coach",
    status: "active",
    lifecycleStage: "active",
    autonomyLevel: 2,
    trustScore: 80,
    successCount: 7,
    name: "Coach",
  } as never;

  const task = {
    id: "tsk_1",
    userId: "usr_1",
    assigneeId: "ag_coach",
    auditorId: "ag_auditor",
    actionType: "internal",
    resource: "task",
    requiresApproval: false,
    estimatedCostCents: 12,
    approvalThresholdCents: null,
    status: "assigned",
    title: "整理要点",
  } as never;

  const grant = {
    id: "agr_1",
    agentId: "ag_coach",
    resource: "task",
    scope: "execute",
    action: "internal_write",
    createdByApprovalId: "apr_1",
    expiresAt: null,
    maxCents: null,
    maxRuns: 3,
    useCount: 1,
    revokedAt: null,
  } as never;

  const usage = {
    limitCents: 5000,
    settledCents: 1200,
    reservedCents: 300,
    unknownCents: 0,
  } as never;

  it("执行者与任务字段按原样映射，不替换成 authoredById 之类的来源", () => {
    const input = buildPolicyInput({
      agent,
      task,
      grants: [grant],
      usage,
      approval: null,
      timezone: "Asia/Shanghai",
      config: SEED_POLICY_CONFIG,
    });

    expect(input.actor.id).toBe("ag_coach");
    expect(input.actor.autonomyLevel).toBe(2);
    expect(input.task.assigneeId).toBe("ag_coach");
    expect(input.task.estimatedCostCents).toBe(12);
    expect(input.timeZone).toBe("Asia/Shanghai");
  });

  it("同一批 grant 同时喂资源授权与常驻授权", () => {
    const input = buildPolicyInput({
      agent,
      task,
      grants: [grant],
      usage,
      approval: null,
      timezone: "UTC",
      config: SEED_POLICY_CONFIG,
    });

    expect(input.grants).toEqual([
      { resource: "task", scope: "execute", revokedAt: null },
    ]);
    expect(input.standingGrants?.[0]).toMatchObject({
      id: "agr_1",
      action: "internal_write",
      maxRuns: 3,
      useCount: 1,
    });
  });

  it("预算取周账本的三段之和，审批只保留判定需要的两个字段", () => {
    const input = buildPolicyInput({
      agent,
      task,
      grants: [],
      usage,
      approval: { status: "approved", consumedAt: null } as never,
      timezone: "UTC",
      config: SEED_POLICY_CONFIG,
    });

    // 已用 + 在途预留 + 未知用量都必须计入：只算 settled 会让同一批钱被花两次。
    expect(input.budget).toEqual({ limitCents: 5000, spentCents: 1500 });
    expect(input.approval).toEqual({ status: "approved", consumedAt: null });
  });
});
