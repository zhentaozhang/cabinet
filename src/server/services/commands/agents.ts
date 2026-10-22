import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, auditEvents, tasks } from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { getPolicyConfig } from "@/lib/policy/config";
import { decideUpgrade } from "@/lib/domain/policy";
import { assertTransition } from "@/lib/domain/state";
import {
  ConflictError,
  NotFoundError,
  PolicyDenied,
  ValidationError,
} from "@/lib/domain/errors";

export async function setAutonomy(agentId: string, level: number, userId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.userId !== userId) {
    throw new NotFoundError("Agent not found");
  }
  if (level < 0 || level > 3) throw new ConflictError("Invalid autonomy level");

  const config = await getPolicyConfig();
  const auditRows = await db
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .innerJoin(tasks, eq(tasks.id, auditEvents.target))
    .where(
      and(
        eq(tasks.assigneeId, agentId),
        inArray(auditEvents.action, ["audit.accept", "audit.reject"]),
      ),
    )
    .orderBy(desc(auditEvents.seq))
    .limit(config.audit.passRateWindow);

  const accepts = auditRows.filter(
    (row) => row.action === "audit.accept",
  ).length;
  const auditPassRate =
    auditRows.length > 0 ? accepts / auditRows.length : 0;

  const decision = decideUpgrade({
    actor: {
      id: agent.id,
      role: agent.role,
      status: agent.status,
      lifecycleStage: agent.lifecycleStage,
      autonomyLevel: agent.autonomyLevel,
      trustScore: agent.trustScore,
      successCount: agent.successCount,
    },
    targetLevel: level,
    auditPassRate,
    config,
  });

  if (decision.effect === "deny") {
    throw new PolicyDenied(decision.reason);
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(agents)
      .set({ autonomyLevel: level })
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.autonomyLevel, agent.autonomyLevel),
        ),
      )
      .returning();
    if (!updated) throw new ConflictError("Agent autonomy changed; retry.");

    await logAuditTx(tx, {
      userId: agent.userId,
      actor: "user",
      action: "autonomy.change",
      target: agentId,
      before: { level: agent.autonomyLevel },
      after: { level, auditPassRate, reason: decision.reason },
    });

    return { level, auditPassRate };
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
    const [updated] = await tx
      .update(agents)
      .set({
        ...(input.status ? { status: nextStatus } : {}),
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
        charter: agent.charter,
        budgetCents: agent.budgetCents,
      },
      after: {
        status: updated.status,
        charter: updated.charter,
        budgetCents: updated.budgetCents,
      },
    });

    return updated;
  });
}
