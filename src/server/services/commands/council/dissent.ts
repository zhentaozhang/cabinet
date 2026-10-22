import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  auditEvents,
  councils,
  dissents,
  runs,
  tasks,
} from "@/lib/db/schema";
import type { Evidence, FalsificationCondition } from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { getPolicyConfig } from "@/lib/policy/config";
import { assertTransition } from "@/lib/domain/state";
import { factSlug, writeMemoryFact } from "../memory/facts";
import { clamp } from "../../shared/numbers";

export function dissentConditionMet(
  value: number,
  condition: FalsificationCondition,
): boolean {
  if (condition.operator === ">=") return value >= condition.threshold;
  if (condition.operator === ">") return value > condition.threshold;
  return value === condition.threshold;
}

export async function measureDissent(
  userId: string,
  dissent: typeof dissents.$inferSelect,
): Promise<number> {
  const start = dissent.createdAt;
  const end = new Date(
    start.getTime() + dissent.condition.windowDays * 24 * 60 * 60 * 1000,
  );
  const metric = dissent.condition.metric;

  if (metric === "audit_reject_count") {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, userId),
          eq(auditEvents.action, "audit.reject"),
          dissent.taskId
            ? eq(auditEvents.target, dissent.taskId)
            : undefined,
          gte(auditEvents.createdAt, start),
          lte(auditEvents.createdAt, end),
        ),
      );
    return Number(row?.count ?? 0);
  }

  if (metric === "budget_spend_cents") {
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${runs.costCents}), 0)` })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(
        and(
          eq(tasks.userId, userId),
          dissent.taskId ? eq(runs.taskId, dissent.taskId) : undefined,
          gte(runs.createdAt, start),
          lte(runs.createdAt, end),
        ),
      );
    return Number(row?.total ?? 0);
  }

  if (metric === "task_failure_count") {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.status, "failed"),
          dissent.taskId ? eq(tasks.id, dissent.taskId) : undefined,
          gte(tasks.updatedAt, start),
          lte(tasks.updatedAt, end),
        ),
      );
    return Number(row?.count ?? 0);
  }

  // `agent_paused` must be measured from events inside the observation window.
  // Reading agents.status alone would make any historical pause permanently
  // vindicate every future dissent.
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.userId, userId),
        inArray(auditEvents.action, ["agent.paused", "agent.update"]),
        sql`${auditEvents.after}->>'status' = 'paused'`,
        gte(auditEvents.createdAt, start),
        lte(auditEvents.createdAt, end),
      ),
    );
  return Number(row?.count ?? 0);
}

export async function evaluateDissents(userId: string): Promise<{
  vindicated: number;
  invalidated: number;
}> {
  const config = await getPolicyConfig();
  const pending = await db
    .select()
    .from(dissents)
    .where(and(eq(dissents.userId, userId), eq(dissents.status, "pending")));

  let vindicated = 0;
  let invalidated = 0;

  for (const dissent of pending) {
    const deadline = new Date(
      dissent.createdAt.getTime() +
        dissent.condition.windowDays * 24 * 60 * 60 * 1000,
    );
    if (deadline > new Date()) continue;

    const value = await measureDissent(userId, dissent);
    const met = dissentConditionMet(value, dissent.condition);
    const evidence: Evidence[] = [
      ...dissent.evidence,
      {
        label: "复盘测量",
        ref: `dissent:${dissent.id}`,
        quote: `${dissent.condition.metric} = ${value}`,
      },
    ];

    if (!met) {
      assertTransition("dissent", dissent.status, "invalidated");
      let changed = false;
      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(dissents)
          .set({
            status: "invalidated",
            evidence,
            evaluatedAt: new Date(),
          })
          .where(
            and(eq(dissents.id, dissent.id), eq(dissents.status, "pending")),
          )
          .returning();
        if (!updated) return;
        changed = true;
        await logAuditTx(tx, {
          userId,
          actor: "system:auditor",
          action: "dissent.invalidated",
          target: dissent.id,
          before: { status: "pending" },
          after: {
            status: "invalidated",
            metric: dissent.condition.metric,
            value,
            threshold: dissent.condition.threshold,
          },
        });
      });
      if (changed) invalidated += 1;
      continue;
    }

    assertTransition("dissent", dissent.status, "vindicated");
    let chief: typeof agents.$inferSelect | undefined;
    let chiefBefore: number | null = null;
    let chiefAfter: number | null = null;
    let updatedDissent: typeof dissents.$inferSelect | undefined;

    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(dissents)
        .set({
          status: "vindicated",
          evidence,
          evaluatedAt: new Date(),
        })
        .where(
          and(eq(dissents.id, dissent.id), eq(dissents.status, "pending")),
        )
        .returning();
      if (!updated) return;
      updatedDissent = updated;

      const [agent] = await tx
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.id, dissent.agentId),
            eq(agents.userId, userId),
          ),
        )
        .limit(1);
      if (agent) {
        await tx
          .update(agents)
          .set({
            trustScore: clamp(agent.trustScore + config.dissent.trustBonus),
          })
          .where(eq(agents.id, agent.id));
      }

      [chief] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.userId, userId), eq(agents.role, "chief")))
        .limit(1);
      if (chief) {
        chiefBefore = chief.trustScore;
        chiefAfter = clamp(chief.trustScore - config.dissent.chiefPenalty);
        await tx
          .update(agents)
          .set({ trustScore: chiefAfter })
          .where(eq(agents.id, chief.id));
      }

      const [council] = await tx
        .select()
        .from(councils)
        .where(eq(councils.id, dissent.councilId))
        .limit(1);
      const topic = council?.topic ?? dissent.councilId;
      await writeMemoryFact(tx, {
        userId,
        agentId: dissent.agentId,
        type: "procedural",
        domain: "council",
        content: `判例（${topic}）：${dissent.warning} 已被现实印证。测量值 ${value}，阈值 ${dissent.condition.operator} ${dissent.condition.threshold}。`,
        confidence: 0.9,
        salience: config.dissent.precedentSalience,
        evidence,
        sourceEventId: dissent.id,
        factKey: `precedent:${factSlug(topic)}`,
        value: `vindicated:${value}`,
      });

      await logAuditTx(tx, {
        userId,
        actor: "system:auditor",
        action: "dissent.vindicated",
        target: dissent.id,
        before: { status: "pending" },
        after: {
          status: "vindicated",
          metric: dissent.condition.metric,
          value,
          threshold: dissent.condition.threshold,
          trustBonus: config.dissent.trustBonus,
          chiefPenalty: config.dissent.chiefPenalty,
        },
      });

      if (chief && chiefBefore !== null) {
        await logAuditTx(tx, {
          userId,
          actor: "system:auditor",
          action: "chief.deviation",
          target: chief.id,
          before: { trustScore: chiefBefore },
          after: {
            trustScore: chiefAfter,
            dissentId: dissent.id,
            councilId: dissent.councilId,
          },
        });
      }
    });

    if (!updatedDissent) continue;
    vindicated += 1;
  }

  return { vindicated, invalidated };
}
