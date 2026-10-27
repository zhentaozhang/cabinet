import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  agentGrants,
  agents,
  approvals,
  tasks,
  users,
} from "@/lib/db/schema";
import { usageCents } from "@/lib/domain/agent-budget";
import { ConflictError, NotFoundError } from "@/lib/domain/errors";
import type { PolicyConfig } from "@/lib/domain/policy";
import type { PolicyExplainInput } from "@/lib/domain/policy-explain";
import { getPolicyConfig } from "@/lib/policy/config";
import { loadWeeklyUsage, type WeeklyUsage } from "../../queries/budget";
import { loadLatestApproval } from "./execution";

export type TaskRow = typeof tasks.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type GrantRow = typeof agentGrants.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;

export type RunContext = {
  task: TaskRow;
  agent: AgentRow;
  timezone: string;
  config: PolicyConfig;
  grants: GrantRow[];
  usage: WeeklyUsage;
  /** 已按 options.clearConsumedApproval 归一化过的「最新一次有效审批」。 */
  approval: ApprovalRow | null;
  policyInput: PolicyExplainInput;
};

export type RunContextOptions = {
  /**
   * 读只的表面（预演、页面）传 false：GET 不该顺手插出一个周预算行。
   */
  provision?: boolean;
  /**
   * 重试时把「已批准的旧审批」当作不存在：run.ts 的既有语义，
   * 一次批准只抵扣一次执行，重试要重新申请。
   */
  clearConsumedApproval?: boolean;
};

/**
 * 把「这一次执行由谁、在什么授权和预算下、跑什么任务」拼成策略输入。
 *
 * 单独抽成纯函数是因为它必须只有一份：预演面板和真实执行但凡有任何一处
 * 取数口径分叉（换了执行者来源、漏了常驻授权、预算用了另一本账），
 * 面板就会在用户点下去之后被现实打脸，而这正是预演唯一的价值所在。
 */
export function buildPolicyInput(input: {
  agent: AgentRow;
  task: TaskRow;
  grants: GrantRow[];
  usage: WeeklyUsage;
  approval: ApprovalRow | null;
  timezone: string;
  config: PolicyConfig;
}): PolicyExplainInput {
  const { agent, task, grants, usage, approval, timezone, config } = input;
  return {
    actor: {
      id: agent.id,
      role: agent.role,
      status: agent.status,
      lifecycleStage: agent.lifecycleStage,
      autonomyLevel: agent.autonomyLevel,
      trustScore: agent.trustScore,
      successCount: agent.successCount,
    },
    task: {
      assigneeId: task.assigneeId,
      auditorId: task.auditorId,
      actionType: task.actionType,
      resource: task.resource,
      requiresApproval: task.requiresApproval,
      estimatedCostCents: task.estimatedCostCents,
      approvalThresholdCents: task.approvalThresholdCents,
      status: task.status,
    },
    // 同一批 grant 行喂两个方向：资源授权（能不能做）和常驻授权
    // （上次的"是"还算不算数）。分开查会漏掉刚被撤销的那一条。
    grants: grants.map((grant) => ({
      resource: grant.resource,
      scope: grant.scope,
      revokedAt: grant.revokedAt,
    })),
    standingGrants: grants.map((grant) => ({
      id: grant.id,
      resource: grant.resource,
      action: grant.action,
      createdByApprovalId: grant.createdByApprovalId,
      expiresAt: grant.expiresAt,
      maxCents: grant.maxCents,
      maxRuns: grant.maxRuns,
      useCount: grant.useCount,
      revokedAt: grant.revokedAt,
    })),
    budget: {
      limitCents: usage.limitCents,
      spentCents: usageCents(usage),
    },
    approval: approval
      ? { status: approval.status, consumedAt: approval.consumedAt }
      : null,
    timeZone: timezone,
    config,
  };
}

/**
 * 一次执行（或一次预演）的全部输入。调用方只需提供任务行本身 —— 归属校验
 * 已经由拿到这一行的查询做过（run.ts 读回后比对 userId，预演把 userId 写进
 * where）。执行者固定是 assignee，绝不用 authoredById 顶替。
 */
export async function loadRunContext(
  task: TaskRow,
  options: RunContextOptions = {},
): Promise<RunContext> {
  if (!task.assigneeId) throw new ConflictError("Task has no assignee");

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, task.assigneeId));
  if (!agent || agent.userId !== task.userId) {
    throw new NotFoundError("Agent not found");
  }

  const [user] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, task.userId));
  const timezone = user?.timezone ?? "UTC";

  // 真实执行用基础策略表：用户级覆盖只开放节奏类键（策略 override 白名单里
  // 没有 autonomy/budget/cost），所以这里叠加覆盖也不会改变判定，不值得为此
  // 让执行路径多依赖一张表。
  const config = await getPolicyConfig();
  const grants = await db
    .select()
    .from(agentGrants)
    .where(and(eq(agentGrants.agentId, agent.id), isNull(agentGrants.revokedAt)));
  // One accounting authority: the persisted weekly period ledger.
  const usage = await loadWeeklyUsage(agent.id, timezone, undefined, undefined, {
    provision: options.provision ?? true,
  });

  let approval = await loadLatestApproval(task.id);
  if (
    options.clearConsumedApproval &&
    approval?.status === "approved" &&
    approval.consumedAt
  ) {
    // A consumed approval is historical. A rejected task gets a fresh approval
    // request instead of being locked out forever.
    approval = null;
  }

  return {
    task,
    agent,
    timezone,
    config,
    grants,
    usage,
    approval,
    policyInput: buildPolicyInput({
      agent,
      task,
      grants,
      usage,
      approval,
      timezone,
      config,
    }),
  };
}
