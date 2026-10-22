import { and, desc, eq, gt, gte, lt, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentBudgetPeriods, agents, runs } from "@/lib/db/schema";
import { periodLimitCents, type BudgetUsage } from "@/lib/domain/agent-budget";
import { addLocalDays, startOfLocalWeek } from "@/lib/domain/time";
import { getPolicyConfig } from "@/lib/policy/config";
import type { Tx } from "../shared/tx";

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
export async function findOpenPeriod(
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
