import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, tasks } from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { assertTransition } from "@/lib/domain/state";
import {
  ConflictError,
  NotFoundError,
  PolicyDenied,
  ValidationError,
} from "@/lib/domain/errors";
import {
  evaluateAutonomyUpgrade,
  loadAutonomyDecisions,
  type AutonomyUpgradeResult,
} from "../queries/autonomy";

export { evaluateAutonomyUpgrade, loadAutonomyDecisions };
export type { AutonomyUpgradeResult };

export async function setAutonomy(agentId: string, level: number, userId: string) {
  if (level < 0 || level > 3) throw new ConflictError("Invalid autonomy level");

  return db.transaction(async (tx) => {
    // Lock the Agent row first. The same ordering as `auditTask` (agent row,
    // then audit event) keeps concurrent audits and promotions from deadlocking,
    // and makes the decision and the write read the same row version.
    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .for("update");
    if (!agent) throw new NotFoundError("Agent not found");

    const result = await evaluateAutonomyUpgrade(agentId, level, userId, tx);
    if (!result.allowed) {
      throw new PolicyDenied(result.reason);
    }

    // Guard every column the decision depended on: an intervening pause,
    // retirement, trust change or level change must invalidate this write.
    const [updated] = await tx
      .update(agents)
      .set({ autonomyLevel: level })
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.autonomyLevel, agent.autonomyLevel),
          eq(agents.status, agent.status),
          eq(agents.lifecycleStage, agent.lifecycleStage),
          eq(agents.trustScore, agent.trustScore),
          eq(agents.successCount, agent.successCount),
        ),
      )
      .returning();
    if (!updated) throw new ConflictError("Agent state changed; retry.");

    await logAuditTx(tx, {
      userId,
      actor: "user",
      action: "autonomy.change",
      target: agentId,
      before: { level: agent.autonomyLevel, status: agent.status },
      after: {
        level,
        status: updated.status,
        passRate: result.passRate,
        samples: result.samples,
        code: result.code,
        reason: result.reason,
      },
    });

    return {
      level,
      passRate: result.passRate,
      samples: result.samples,
      code: result.code,
    };
  });
}

export async function updateAgent(
  agentId: string,
  input: {
    status?: "active" | "paused" | "retired";
    charter?: string;
    budgetCents?: number;
  },
  userId: string,
) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.userId !== userId) {
    throw new NotFoundError("Agent not found");
  }

  const nextStatus = input.status ?? agent.status;
  const retiring = input.status === "retired" && agent.status !== "retired";
  if (input.status && input.status !== agent.status) {
    assertTransition("agent", agent.status, input.status);
    if (input.status === "retired") {
      const [openRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(
          and(
            eq(tasks.assigneeId, agentId),
            inArray(tasks.status, [
              "planned",
              "assigned",
              "awaiting_approval",
              "approved",
              "running",
              "submitted",
              "auditing",
              "needs_review",
              "rejected",
              "suggested",
            ]),
          ),
        );
      if (Number(openRow?.count ?? 0) > 0) {
        throw new ConflictError(
          "Reassign open tasks before retiring this agent.",
        );
      }
    }
  }

  if (input.charter !== undefined && input.charter.trim().length < 20) {
    throw new ValidationError("Charter must be at least 20 characters.");
  }

  if (
    input.budgetCents !== undefined &&
    (!Number.isInteger(input.budgetCents) || input.budgetCents < 0)
  ) {
    throw new ValidationError("Budget must be a non-negative integer.");
  }

  return db.transaction(async (tx) => {
    const retiredAt = retiring ? new Date() : agent.retiredAt;
    const [updated] = await tx
      .update(agents)
      .set({
        ...(input.status ? { status: nextStatus } : {}),
        ...(retiring
          ? { lifecycleStage: "retired", retiredAt }
          : {}),
        ...(input.charter !== undefined
          ? { charter: input.charter.trim() }
          : {}),
        ...(input.budgetCents !== undefined
          ? { budgetCents: input.budgetCents }
          : {}),
      })
      .where(and(eq(agents.id, agentId), eq(agents.status, agent.status)))
      .returning();
    if (!updated) throw new ConflictError("Agent state changed; retry.");

    await logAuditTx(tx, {
      userId: agent.userId,
      actor: "user",
      action: "agent.update",
      target: agentId,
      before: {
        status: agent.status,
        lifecycleStage: agent.lifecycleStage,
        retiredAt: agent.retiredAt?.toISOString() ?? null,
        charter: agent.charter,
        budgetCents: agent.budgetCents,
      },
      after: {
        status: updated.status,
        lifecycleStage: updated.lifecycleStage,
        retiredAt: updated.retiredAt?.toISOString() ?? null,
        charter: updated.charter,
        budgetCents: updated.budgetCents,
      },
    });

    return updated;
  });
}
