import { and, eq, isNull } from "drizzle-orm";

import { handleQueryWithRequest } from "@/lib/api/read";
import { db } from "@/lib/db";
import { agentGrants, agents, tasks, users } from "@/lib/db/schema";
import { usageCents } from "@/lib/domain/agent-budget";
import { ConflictError } from "@/lib/domain/errors";
import {
  explainRunPolicy,
  type PolicyExplanation,
} from "@/lib/domain/policy-explain";
import { getPolicyConfig } from "@/lib/policy/config";
import { loadLatestApproval } from "@/server/services/commands/tasks/execution";
import { loadWeeklyUsage } from "@/server/services/queries/budget";

export type PolicyPreview = Pick<
  PolicyExplanation,
  "effect" | "rule" | "reason" | "missing"
>;

/**
 * 预演一次「点运行会发生什么」。
 *
 * 这里刻意把 run.ts 的取数顺序和字段原样复刻一遍（同样的 assignee 作为执行者、
 * 同样的 grant/审批/周预算来源），因为预演的价值完全建立在「和真实运行同一份
 * 输入」上：任何一处取数不一致，面板就会在用户点下去之后被现实打脸。
 * 判定本身不在这里 —— 它由 explainRunPolicy → decideRun 给出。
 *
 * 同步义务（src/server/services/commands/tasks/run.ts:83-170）：那边改了取数
 * 口径（比如改用用户级策略覆盖、或换掉执行者来源），这里必须跟着改。
 */
async function loadPolicyPreview(
  taskId: string,
  userId: string,
): Promise<PolicyPreview | null> {
  // 归属条件写在 where 里而不是查回来再比对：别人的任务和不存在的任务
  // 从这里出去是同一个 null，路由层统一回 404，不能用来探测别人的任务 id。
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
  if (!task) return null;

  // 没有执行者就没有可预演的判定：run.ts:89 会以同一个 409 拒绝执行，
  // 预演跟着报同一件事，比伪装成「放行」诚实。
  if (!task.assigneeId) throw new ConflictError("Task has no assignee");

  // 执行者 = 任务的 assignee，不是 authoredById —— 与 run.ts:96 保持一致。
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, task.assigneeId));
  if (!agent || agent.userId !== userId) return null;

  const [user] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, task.userId));
  const timezone = user?.timezone ?? "UTC";

  // 与 run.ts:110 保持一致：真实执行用的是基础策略表，不是用户级覆盖。
  // 预演如果叠加覆盖就会「显示允许、实际拒绝」，所以这里宁可复刻现状。
  const config = await getPolicyConfig();
  const grants = await db
    .select()
    .from(agentGrants)
    .where(and(eq(agentGrants.agentId, agent.id), isNull(agentGrants.revokedAt)));
  // provision: false —— GET 不能顺手建出一个预算周期行。
  const usage = await loadWeeklyUsage(agent.id, timezone, undefined, undefined, {
    provision: false,
  });
  const approval = await loadLatestApproval(taskId);

  const explained = explainRunPolicy({
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
  });

  return {
    effect: explained.effect,
    rule: explained.rule,
    reason: explained.reason,
    missing: explained.missing,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleQueryWithRequest(request, (userId) =>
    loadPolicyPreview(id, userId),
  );
}
