import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { agentGrants, agents } from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { normalizeAction } from "@/lib/domain/policy";
import { NotFoundError, ValidationError } from "@/lib/domain/errors";
import type { Tx } from "../../shared/tx";

export const STANDING_MIN_DAYS = 1;
export const STANDING_MAX_DAYS = 180;
export const STANDING_MAX_RUNS = 200;

export type RememberInput = {
  days: number;
  maxCents?: number | null;
  maxRuns?: number | null;
};

export function normalizeRemember(input: RememberInput): {
  days: number;
  maxCents: number | null;
  maxRuns: number;
} {
  const days = Math.trunc(input.days);
  if (!Number.isFinite(days) || days < STANDING_MIN_DAYS || days > STANDING_MAX_DAYS) {
    throw new ValidationError(
      `记住时长必须在 ${STANDING_MIN_DAYS}–${STANDING_MAX_DAYS} 天之间。`,
    );
  }

  const maxRuns =
    input.maxRuns === null || input.maxRuns === undefined
      ? null
      : Math.trunc(input.maxRuns);
  if (maxRuns !== null && (maxRuns < 1 || maxRuns > STANDING_MAX_RUNS)) {
    throw new ValidationError(`次数上限必须在 1–${STANDING_MAX_RUNS} 之间。`);
  }

  const maxCents =
    input.maxCents === null || input.maxCents === undefined
      ? null
      : Math.trunc(input.maxCents);
  if (maxCents !== null && (maxCents < 0 || maxCents > 100_000_000)) {
    throw new ValidationError("金额上限不合法。");
  }

  return { days, maxCents, maxRuns: maxRuns ?? 20 };
}

/**
 * Turn one approval into a bounded standing policy.
 *
 * Deliberately strict: a policy covers one agent, one resource and one action
 * class. Spending additionally requires a money ceiling, because "same as last
 * time" must never mean "whatever it costs". Any earlier policy for the same
 * agent/resource/action is revoked in the same breath, so there is never more
 * than one live rule to reason about.
 */
export async function createStandingGrantFromApproval(
  input: {
    userId: string;
    agentId: string;
    resource: string;
    actionType: string;
    approvalId: string;
    taskTitle: string;
    remember: RememberInput;
  },
  tx: Tx,
): Promise<{ id: string; expiresAt: Date; maxRuns: number; maxCents: number | null }> {
  const { days, maxCents, maxRuns } = normalizeRemember(input.remember);
  const action = normalizeAction(input.actionType);
  if (action === "unknown" || action === "admin" || action === "audit") {
    throw new ValidationError("这类动作不能沉淀为长期策略，必须每次确认。");
  }
  if (action === "spend" && maxCents === null) {
    throw new ValidationError("花钱的动作必须设置单次金额上限。");
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const id = newId("grt");

  // One live rule per (agent, resource, action): re-approving replaces it.
  await tx
    .update(agentGrants)
    .set({
      revokedAt: now,
      revokedReason: "被更新的批准策略取代",
    })
    .where(
      and(
        eq(agentGrants.agentId, input.agentId),
        eq(agentGrants.resource, input.resource),
        eq(agentGrants.action, action),
        isNull(agentGrants.revokedAt),
      ),
    );

  await tx.insert(agentGrants).values({
    id,
    agentId: input.agentId,
    resource: input.resource,
    scope: "write",
    config: {},
    action,
    label: `你批准过「${input.taskTitle}」，允许同类动作自动执行`,
    createdByApprovalId: input.approvalId,
    expiresAt,
    maxCents,
    maxRuns,
    useCount: 0,
  });

  await logAuditTx(tx, {
    userId: input.userId,
    actor: "user",
    action: "grant.create",
    target: id,
    after: {
      agentId: input.agentId,
      resource: input.resource,
      action,
      approvalId: input.approvalId,
      expiresAt: expiresAt.toISOString(),
      maxRuns,
      maxCents,
    },
  });

  return { id, expiresAt, maxRuns, maxCents };
}

/**
 * Revoke a policy. Ownership is resolved through the agent row, because grants
 * are scoped to an agent and carry no user column of their own.
 */
export async function revokeGrant(
  grantId: string,
  userId: string,
  reason?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: agentGrants.id,
        agentId: agentGrants.agentId,
        useCount: agentGrants.useCount,
        action: agentGrants.action,
        resource: agentGrants.resource,
        revokedAt: agentGrants.revokedAt,
      })
      .from(agentGrants)
      .innerJoin(agents, eq(agentGrants.agentId, agents.id))
      .where(and(eq(agentGrants.id, grantId), eq(agents.userId, userId)));

    if (!row) throw new NotFoundError("授权不存在。");
    if (row.revokedAt) return;

    await tx
      .update(agentGrants)
      .set({ revokedAt: new Date(), revokedReason: reason ?? "用户手动撤销" })
      .where(and(eq(agentGrants.id, grantId), isNull(agentGrants.revokedAt)));

    await logAuditTx(tx, {
      userId,
      actor: "user",
      action: "grant.revoke",
      target: grantId,
      before: { revokedAt: null, useCount: row.useCount },
      after: {
        revokedAt: new Date().toISOString(),
        reason: reason ?? "用户手动撤销",
        agentId: row.agentId,
        resource: row.resource,
        action: row.action,
      },
    });
  });
}
