import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { insights, memories, profiles, tasks } from "@/lib/db/schema";
import { logAudit } from "@/lib/audit";
import { ConflictError, NotFoundError } from "@/lib/domain/errors";
import type { Tx } from "../../shared/tx";
import { factForChange, writeMemoryFact } from "./facts";

async function applyChange(
  tx: Tx,
  change: {
    type: string;
    taskId?: string;
    to?: string;
    minutes?: number;
    rule?: string;
  },
  userId: string,
): Promise<{
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}> {
  if (change.type === "reschedule" && change.taskId && change.to) {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, change.taskId));
    if (!task) throw new NotFoundError("Task not found");
    const [h, m] = change.to.split(":").map(Number);
    const next = new Date();
    next.setHours(h, m, 0, 0);
    await tx
      .update(tasks)
      .set({ dueAt: next, updatedAt: new Date() })
      .where(eq(tasks.id, change.taskId));
    return {
      before: { dueAt: task.dueAt ? task.dueAt.toISOString() : null },
      after: { dueAt: next.toISOString() },
    };
  }

  if (change.type === "split_task" && change.taskId && change.minutes) {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, change.taskId));
    if (!task) throw new NotFoundError("Task not found");
    await tx
      .update(tasks)
      .set({ estimateMin: change.minutes, updatedAt: new Date() })
      .where(eq(tasks.id, change.taskId));
    return {
      before: { estimateMin: task.estimateMin },
      after: { estimateMin: change.minutes },
    };
  }

  if (change.type === "add_rule" && change.rule) {
    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId));
    const preferences = (profile?.preferences ?? {}) as Record<string, unknown>;
    const beforeRules = Array.isArray(preferences.rules)
      ? ([...preferences.rules] as string[])
      : [];
    const nextRules = beforeRules.includes(change.rule)
      ? beforeRules
      : [...beforeRules, change.rule];
    await tx
      .update(profiles)
      .set({
        preferences: { ...preferences, rules: nextRules },
        updatedAt: new Date(),
      })
      .where(eq(profiles.userId, userId));
    return {
      before: { rules: beforeRules },
      after: { rules: nextRules },
    };
  }

  return { before: null, after: null };
}

async function reverseChange(
  tx: Tx,
  change: {
    type: string;
    taskId?: string;
    from?: string;
    rule?: string;
  },
  userId: string,
  beforeState: Record<string, unknown> | null,
): Promise<void> {
  if (!beforeState) {
    throw new ConflictError(
      "This insight has no stored rollback state; cannot roll back safely.",
    );
  }

  if (change.type === "reschedule" && change.taskId) {
    const dueAt = beforeState.dueAt;
    if (typeof dueAt !== "string") {
      throw new ConflictError("Rollback state is missing dueAt.");
    }
    await tx
      .update(tasks)
      .set({ dueAt: new Date(dueAt), updatedAt: new Date() })
      .where(eq(tasks.id, change.taskId));
    return;
  }

  if (change.type === "split_task" && change.taskId) {
    const estimateMin = beforeState.estimateMin;
    if (typeof estimateMin !== "number") {
      throw new ConflictError("Rollback state is missing estimateMin.");
    }
    await tx
      .update(tasks)
      .set({ estimateMin, updatedAt: new Date() })
      .where(eq(tasks.id, change.taskId));
    return;
  }

  if (change.type === "add_rule") {
    const rules = beforeState.rules;
    if (!Array.isArray(rules)) {
      throw new ConflictError("Rollback state is missing rules.");
    }
    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId));
    const preferences = (profile?.preferences ?? {}) as Record<string, unknown>;
    await tx
      .update(profiles)
      .set({
        preferences: { ...preferences, rules },
        updatedAt: new Date(),
      })
      .where(eq(profiles.userId, userId));
  }
}

export async function applyInsight(
  insightId: string,
  action: "accept" | "reject" | "rollback",
  userId: string,
) {
  const [insight] = await db
    .select()
    .from(insights)
    .where(eq(insights.id, insightId));
  if (!insight || insight.userId !== userId) {
    throw new NotFoundError("Insight not found");
  }

  if (action === "reject") {
    if (insight.status !== "proposed") {
      throw new ConflictError(`Cannot reject an insight in ${insight.status}.`);
    }
    const [updated] = await db
      .update(insights)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(and(eq(insights.id, insightId), eq(insights.status, "proposed")))
      .returning();
    if (!updated) throw new ConflictError("Insight state changed; retry.");
    await logAudit({
      userId: insight.userId,
      actor: "user",
      action: "insight.reject",
      target: insightId,
      before: { status: insight.status },
      after: { status: "rejected" },
    });
    return;
  }

  if (action === "rollback") {
    if (insight.status !== "applied") {
      throw new ConflictError(
        `Cannot roll back an insight in ${insight.status}.`,
      );
    }

    await db.transaction(async (tx) => {
      const [locked] = await tx
        .update(insights)
        .set({ status: "rolled_back", decidedAt: new Date() })
        .where(
          and(eq(insights.id, insightId), eq(insights.status, "applied")),
        )
        .returning();
      if (!locked) throw new ConflictError("Insight state changed; retry.");

      await reverseChange(
        tx,
        insight.proposedChange,
        insight.userId,
        insight.beforeState,
      );
    });

    await logAudit({
      userId: insight.userId,
      actor: "user",
      action: "insight.rollback",
      target: insightId,
      before: { status: insight.status },
      after: { status: "rolled_back" },
    });
    return;
  }

  if (insight.status !== "proposed") {
    throw new ConflictError(`Cannot accept an insight in ${insight.status}.`);
  }

  await db.transaction(async (tx) => {
    const state = await applyChange(tx, insight.proposedChange, insight.userId);

    const [updated] = await tx
      .update(insights)
      .set({
        status: "applied",
        beforeState: state.before,
        afterState: state.after,
        decidedAt: new Date(),
      })
      .where(and(eq(insights.id, insightId), eq(insights.status, "proposed")))
      .returning();
    if (!updated) throw new ConflictError("Insight state changed; retry.");

    const [existingMemory] = await tx
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.userId, insight.userId),
          eq(memories.sourceEventId, insight.id),
        ),
      )
      .limit(1);
    if (existingMemory) return;

    const domain =
      insight.proposedChange.type === "reschedule" ? "health" : "learning";
    const fact = factForChange(insight.proposedChange);
    await writeMemoryFact(tx, {
      userId: insight.userId,
      agentId: "ag_chief",
      type: "semantic",
      domain,
      content: insight.claim,
      confidence: insight.confidence,
      salience: 0.8,
      evidence: insight.evidence,
      sourceEventId: insight.id,
      factKey: fact?.factKey ?? null,
      value: fact?.value ?? null,
    });
  });

  await logAudit({
    userId: insight.userId,
    actor: "user",
    action: "insight.accept",
    target: insightId,
    before: { status: insight.status },
    after: { status: "applied", change: insight.proposedChange },
  });
}
