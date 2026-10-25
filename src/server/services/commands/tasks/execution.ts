import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agentBudgetReservations,
  agents,
  approvals,
} from "@/lib/db/schema";
import {
  decideReservation,
  effectiveLimitCents,
  periodLimitCents,
  type ReservationDecision,
} from "@/lib/domain/agent-budget";
import { getPolicyConfig } from "@/lib/policy/config";
import type { Tx } from "../../shared/tx";
import {
  budgetWeek,
  findOpenPeriod,
  loadWeeklyUsage,
  type BudgetWeek,
  type WeeklyUsage,
} from "../../queries/budget";

export { budgetWeek, findOpenPeriod, loadWeeklyUsage };
export type { BudgetWeek, WeeklyUsage };

export type ReserveInput = {
  userId: string;
  agentId: string;
  taskId: string | null;
  timezone: string;
  amountCents: number;
  now?: Date;
};

/**
 * Admission protocol: ensure the period row, lock it, decide, then persist the
 * hold. The reservation is durable before any provider request, so two
 * concurrent runs cannot both spend the last allowance.
 */
export async function reserveBudget(
  input: ReserveInput,
  /** Pass the caller's transaction to make the hold atomic with its work. */
  client?: Tx,
): Promise<
  | { allowed: false; reason: string }
  | { allowed: true; reservationId: string; periodId: string; amountCents: number }
> {
  const run = async (tx: Tx) => {
    const now = input.now ?? new Date();
    const { periodStart, periodEnd } = budgetWeek(input.timezone, now);
    const [agent] = await tx
      .select({
        id: agents.id,
        userId: agents.userId,
        budgetCents: agents.budgetCents,
      })
      .from(agents)
      .where(eq(agents.id, input.agentId));
    if (!agent) throw new Error(`Unknown agent ${input.agentId}`);

    const config = await getPolicyConfig();
    const limitCents = periodLimitCents(
      agent.budgetCents,
      config.budget.weeklyLimitCents,
    );

    if (!(await findOpenPeriod(tx, input.agentId, now))) {
      await tx
        .insert(agentBudgetPeriods)
        .values({
          id: `bpd_${input.agentId}_${periodStart.getTime()}`,
          userId: agent.userId,
          agentId: input.agentId,
          timezone: input.timezone,
          periodStart,
          periodEnd,
          limitCents,
        })
        .onConflictDoNothing({
          target: [agentBudgetPeriods.agentId, agentBudgetPeriods.periodStart],
        });
    }

    // Serialises concurrent reservations for this Agent and week.
    const [period] = await tx
      .select()
      .from(agentBudgetPeriods)
      .where(
        and(
          eq(agentBudgetPeriods.agentId, input.agentId),
          lte(agentBudgetPeriods.periodStart, now),
          gt(agentBudgetPeriods.periodEnd, now),
        ),
      )
      .orderBy(desc(agentBudgetPeriods.periodStart))
      .limit(1)
      .for("update");

    // A missing bucket is not "unlimited allowance": without the row there is
    // nothing to hold the reservation against, and dereferencing it threw a
    // TypeError that surfaced as a 500. The two refusals stay distinguishable
    // so a closed week never reads as a lost one.
    if (!period) {
      return {
        allowed: false as const,
        reason: "未找到当前预算周期，无法预留预算。",
      };
    }
    // Refuse a closed period before any of its fields are read as authority.
    if (period.closedAt) {
      return { allowed: false as const, reason: "该预算周期已关闭。" };
    }

    const decision: ReservationDecision = decideReservation(
      {
        // Read the same live limit `loadWeeklyUsage` reports, so the number the
        // UI shows is the number admission used. The stored snapshot is only a
        // ceiling: lowering an Agent's cap mid-week must bite in this week.
        limitCents: effectiveLimitCents(
          period.limitCents,
          agent.budgetCents,
          config.budget.weeklyLimitCents,
        ),
        reservedCents: period.reservedCents,
        settledCents: period.settledCents,
        unknownCents: period.unknownCents,
        overrun: period.overrun,
      },
      input.amountCents,
    );
    if (!decision.allowed) return decision;

    const amountCents = Math.max(0, input.amountCents);
    await tx
      .update(agentBudgetPeriods)
      .set({
        reservedCents: sql`${agentBudgetPeriods.reservedCents} + ${amountCents}`,
      })
      .where(eq(agentBudgetPeriods.id, period.id));

    const reservationId = `brs_${period.id}_${eligibleStamp(now)}`;
    await tx.insert(agentBudgetReservations).values({
      id: reservationId,
      userId: agent.userId,
      periodId: period.id,
      agentId: input.agentId,
      taskId: input.taskId,
      state: "reserved",
      amountCents,
    });

    return { allowed: true as const, reservationId, periodId: period.id, amountCents };
  };
  return client ? run(client) : db.transaction(run);
}

function eligibleStamp(now: Date): string {
  return `${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
}

export type SettleInput = {
  /** The run whose hold is settled. Omit when `reservationId` names it. */
  runId?: string | null;
  /**
   * Settle one specific hold by id. Per-tool calls hold their own reservation,
   * so they cannot share the run-level one (that row is unique per run).
   */
  reservationId?: string | null;
  settlement:
    | { state: "not_contacted" }
    | { state: "known_usage"; estimatedCents: number }
    | { state: "unknown_usage" };
  providerAttemptId?: string | null;
  reason?: string | null;
};

/**
 * Settle the hold for a run inside the caller's transaction so the bucket, the
 * reservation state and the run telemetry commit together. Idempotent: a
 * reservation that is not `reserved` is left untouched.
 */
export async function settleBudget(
  tx: Tx,
  input: SettleInput,
): Promise<{ outcome: string | null; settledCents: number; unknownCents: number } | null> {
  const target = input.reservationId
    ? eq(agentBudgetReservations.id, input.reservationId)
    : input.runId
      ? eq(agentBudgetReservations.runId, input.runId)
      : null;
  if (!target) throw new Error("settleBudget requires runId or reservationId.");

  const [reservation] = await tx
    .select()
    .from(agentBudgetReservations)
    .where(target)
    .for("update");
  if (!reservation || reservation.state !== "reserved") return null;

  const settlement =
    input.settlement.state === "not_contacted"
      ? { state: "released", settledCents: 0, unknownCents: 0, overrun: false }
      : input.settlement.state === "unknown_usage"
        ? {
            state: "unknown_charged",
            settledCents: 0,
            unknownCents: reservation.amountCents,
            overrun: false,
          }
        : {
            state: "settled",
            settledCents: Math.max(0, input.settlement.estimatedCents),
            unknownCents: 0,
            overrun:
              Math.max(0, input.settlement.estimatedCents) > reservation.amountCents,
          };

  const [period] = await tx
    .select()
    .from(agentBudgetPeriods)
    .where(eq(agentBudgetPeriods.id, reservation.periodId))
    .for("update");

  // No affected-row assertion here, deliberately: `agent_budget_reservations.period_id`
  // is a foreign key to this row and the SELECT above already took a row lock,
  // so the row cannot disappear between the read and the write. AGENTS.md 第 1 条
  // asks for a checked rowcount where a concurrent writer can change the target
  // (a task status); here a zero would mean the database lost a foreign key.
  await tx
    .update(agentBudgetPeriods)
    .set({
      reservedCents: sql`${agentBudgetPeriods.reservedCents} - ${reservation.amountCents}`,
      settledCents: sql`${agentBudgetPeriods.settledCents} + ${settlement.settledCents}`,
      unknownCents: sql`${agentBudgetPeriods.unknownCents} + ${settlement.unknownCents}`,
      overrun: settlement.overrun ? true : sql`${agentBudgetPeriods.overrun}`,
    })
    .where(eq(agentBudgetPeriods.id, period.id));

  await tx
    .update(agentBudgetReservations)
    .set({
      state: settlement.state,
      settledCents: settlement.settledCents,
      providerAttemptId: input.providerAttemptId ?? null,
      reason: input.reason ?? null,
      // Database clock, not the process clock: a worker with a skewed clock
      // must not be able to make a settlement look older than its reservation.
      settledAt: sql`now()`,
    })
    .where(eq(agentBudgetReservations.id, reservation.id));

  return {
    outcome: settlement.state,
    settledCents: settlement.settledCents,
    unknownCents: settlement.unknownCents,
  };
}

export async function loadLatestApproval(
  taskId: string,
  tx?: Tx,
): Promise<typeof approvals.$inferSelect | null> {
  const client = tx ?? db;
  const [row] = await client
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.taskId, taskId),
        or(
          eq(approvals.status, "pending"),
          eq(approvals.status, "approved"),
        ),
        or(isNull(approvals.expiresAt), gt(approvals.expiresAt, new Date())),
      ),
    )
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  return row ?? null;
}
