import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import {
  agentBudgetReservations,
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
    // 花的钱要和台账同一口径，否则这条异议会被钱真的花掉的那一周驳倒。
    //
    // 只累加 runs.cost_cents 有两个洞：
    // 1. 超时 / 供应商报错 / 进程中断的调用「可能已经花了钱」，run 上
    //    cost_cents 保持默认 0（run-usage.ts 与 schema/runs.ts 都写明 null 不等于
    //    零），这一份敞口只记在预算台账的 unknown_charged 行上；把它们当 0，
    //    等于让「没报用量」变成「没花钱」——恰恰是 treasurer 那条预算异议要抓的事。
    // 2. 模型自己挑工具 / MCP 工具每次调用都单独占一份预算（run_id 为空的那批
    //    reservation），它们的钱从不写进任何 run，只记在台账的 settled_cents 上。
    //
    // 两处都只在窗口内累加，run 级 reservation 的 settled 部分不再加一次：
    // 那笔金额就是 run.cost_cents 本身，重复计入会让同一次调用算成两笔。
    const inWindow = (column: AnyPgColumn) =>
      and(gte(column, start), lte(column, end));
    const [spent, exposure, toolSpend] = await Promise.all([
      db
        .select({ total: sql<number>`coalesce(sum(${runs.costCents}), 0)` })
        .from(runs)
        .innerJoin(tasks, eq(tasks.id, runs.taskId))
        .where(and(eq(tasks.userId, userId), inWindow(runs.createdAt))),
      db
        .select({
          total: sql<number>`coalesce(sum(${agentBudgetReservations.amountCents}), 0)`
        })
        .from(agentBudgetReservations)
        .where(
          and(
            eq(agentBudgetReservations.userId, userId),
            isNotNull(agentBudgetReservations.runId),
            eq(agentBudgetReservations.state, "unknown_charged"),
            inWindow(agentBudgetReservations.createdAt),
          ),
        ),
      db
        .select({
          total: sql<number>`coalesce(sum(${agentBudgetReservations.settledCents}), 0)`
        })
        .from(agentBudgetReservations)
        .where(
          and(
            eq(agentBudgetReservations.userId, userId),
            isNull(agentBudgetReservations.runId),
            inWindow(agentBudgetReservations.createdAt),
          ),
        ),
    ]);
    return (
      Number(spent[0]?.total ?? 0) +
      Number(exposure[0]?.total ?? 0) +
      Number(toolSpend[0]?.total ?? 0)
    );
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

      // 信任分是"在现有值上加/减"的量，必须锁住这一行再算再写：
      // 审计路径（commands/tasks/audit.ts）用 SQL 原子自增，如果它在我们读到旧值之后
      // 提交，直接 set(before ± delta) 会把那一次已提交的增量抹掉，也会让下面
      // chief.deviation 审计行里的 before/after 与库里对不上（AGENTS.md 第 2 条）。
      const [agent] = await tx
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.id, dissent.agentId),
            eq(agents.userId, userId),
          ),
        )
        .limit(1)
        .for("update");
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
        .limit(1)
        .for("update");
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
