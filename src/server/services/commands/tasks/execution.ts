import { and, desc, eq, gt, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agentBudgetReservations,
  agents,
  approvals,
  runs,
} from "@/lib/db/schema";
import {
  decideReservation,
  periodLimitCents,
  type BudgetUsage,
  type ReservationDecision,
} from "@/lib/domain/agent-budget";
import { startOfLocalWeek, addLocalDays } from "@/lib/domain/time";
import { getPolicyConfig } from "@/lib/policy/config";
import type { Tx } from "../../shared/tx";

/**
 * Legacy columns `agents.spentCents` / `agents.budgetPeriodStart` are frozen:
 * they are no longer written and no longer decide admission. Durable accounting
 * lives in `agentBudgetPeriods` / `agentBudgetReservations`.
 */
export type WeeklyUsage = BudgetUsage & {
  periodId: string | null;
  periodStart: Date;
  periodEnd: Date;
  timezone: string;
  /** True when a week containing runs predates the ledger rows. */
  legacyUnclassified: boolean;
};

export type BudgetWeek = { periodStart: Date; periodEnd: Date };

/**
 * An existing bucket whose recorded [start, end) contains `now` keeps its own
 * timezone boundaries. A timezone change therefore applies to the NEXT bucket
 * instead of reinterpreting the current one.
 */
async function findOpenPeriod(
  client: typeof db | Tx,
  agentId: string,
  now: Date,
): Promise<typeof agentBudgetPeriods.$inferSelect | undefined> {
  const [row] = await client
    .select()
    .from(agentBudgetPeriods)
    .where(
      and(
        eq(agentBudgetPeriods.agentId, agentId),
        lte(agentBudgetPeriods.periodStart, now),
        gt(agentBudgetPeriods.periodEnd, now),
      ),
    )
    .orderBy(desc(agentBudgetPeriods.periodStart))
    .limit(1);
  return row;
}

export function budgetWeek(timezone: string, now: Date = new Date()): BudgetWeek {
  const periodStart = startOfLocalWeek(now, timezone);
  return {
    periodStart,
    periodEnd: addLocalDays(periodStart, 7, timezone),
  };
}

/**
 * The single read seam for "how much of this week's Agent budget is used".
 * Creates the current period row on read (unbilled) and never writes a charge.
 *
 * Pass `provision: false` from read-only surfaces (page loads) so a GET never
 * inserts a bucket: an unbilled bucket still reads as null periodId with zeros.
 */
export async function loadWeeklyUsage(
  agentId: string,
  timezone: string,
  now: Date = new Date(),
  tx?: Tx,
  options: { provision?: boolean } = {},
): Promise<WeeklyUsage> {
  const provision = options.provision ?? true;
  const client = tx ?? db;
  const { periodStart, periodEnd } = budgetWeek(timezone, now);
  const [agent] = await client
    .select({
      id: agents.id,
      userId: agents.userId,
      budgetCents: agents.budgetCents,
    })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!agent) {
    throw new Error(`Unknown agent ${agentId}`);
  }
  const config = await getPolicyConfig();
  const limitCents = periodLimitCents(agent.budgetCents, config.budget.weeklyLimitCents);

  const open = await findOpenPeriod(client, agentId, now);
  // A week that already holds runs from before the ledger existed must be
  // reported as legacy-unclassified, never converted into measured spend.
  let legacyUnclassified = false;
  if (!open) {
    const [preLedger] = await client
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.agentId, agentId),
          gte(runs.createdAt, periodStart),
          lt(runs.createdAt, periodEnd),
        ),
      )
      .limit(1);
    legacyUnclassified = Boolean(preLedger);
    if (provision) {
      await client
        .insert(agentBudgetPeriods)
        .values({
          id: `bpd_${agentId}_${periodStart.getTime()}`,
          userId: agent.userId,
          agentId,
          timezone,
          periodStart,
          periodEnd,
          limitCents,
        })
        .onConflictDoNothing({
          target: [agentBudgetPeriods.agentId, agentBudgetPeriods.periodStart],
        });
    }
  }

  const period =
    open ??
    (
      await client
        .select()
        .from(agentBudgetPeriods)
        .where(
          and(
            eq(agentBudgetPeriods.agentId, agentId),
            eq(agentBudgetPeriods.periodStart, periodStart),
          ),
        )
    )[0];

  if (period) {
    return {
      periodId: period.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      timezone: period.timezone,
      limitCents: period.limitCents,
      reservedCents: period.reservedCents,
      settledCents: period.settledCents,
      unknownCents: period.unknownCents,
      overrun: period.overrun,
      legacyUnclassified,
    };
  }

  // No period row: report a read-only zero bucket.
  return {
    periodId: null,
    periodStart,
    periodEnd,
    timezone,
    limitCents,
    reservedCents: 0,
    settledCents: 0,
    unknownCents: 0,
    overrun: false,
    legacyUnclassified,
  };
}

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
): Promise<
  | { allowed: false; reason: string }
  | { allowed: true; reservationId: string; periodId: string; amountCents: number }
> {
  return db.transaction(async (tx) => {
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

    const decision: ReservationDecision = decideReservation(
      {
        limitCents: period.limitCents,
        reservedCents: period.reservedCents,
        settledCents: period.settledCents,
        unknownCents: period.unknownCents,
        overrun: period.overrun,
      },
      input.amountCents,
    );
    if (!decision.allowed) return decision;
    if (period.closedAt) {
      return { allowed: false as const, reason: "该预算周期已关闭。" };
    }

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
  });
}

function eligibleStamp(now: Date): string {
  return `${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
}

export type SettleInput = {
  runId: string;
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
  const [reservation] = await tx
    .select()
    .from(agentBudgetReservations)
    .where(eq(agentBudgetReservations.runId, input.runId))
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
      settledAt: new Date(),
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
