/**
 * Weekly Agent budget ledger — pure decision helpers.
 *
 * The persisted period row is the only accounting authority. `runs.cost_cents`
 * is telemetry and never decides admission. All arithmetic here is pure so the
 * contract can be tested without a database; locking and persistence live in
 * the command services.
 */

export type BudgetUsage = {
  /** Effective limit of the current period, in cents. */
  limitCents: number;
  /** Holds committed to attempts that have not settled yet. */
  reservedCents: number;
  /** Settled estimated cost of attempts with known usage. */
  settledCents: number;
  /** Conservative exposure for attempts whose usage is unavailable. */
  unknownCents: number;
  /** An estimate exceeded its reservation in this period. */
  overrun: boolean;
};

export function usageCents(usage: BudgetUsage): number {
  return usage.reservedCents + usage.settledCents + usage.unknownCents;
}

export function remainingCents(usage: BudgetUsage): number {
  return Math.max(0, usage.limitCents - usageCents(usage));
}

/**
 * The per-Agent cap is the tighter guard; the workspace weekly ceiling is the
 * global bound. A zero per-Agent cap means "use the policy ceiling".
 */
export function periodLimitCents(
  agentBudgetCents: number,
  weeklyLimitCents: number,
): number {
  return agentBudgetCents > 0
    ? Math.min(agentBudgetCents, weeklyLimitCents)
    : weeklyLimitCents;
}

/**
 * The limit a period is actually judged against.
 *
 * `agentBudgetPeriods.limitCents` is written once, when the bucket is created,
 * so that later policy edits cannot rewrite history. That snapshot is wrong for
 * one direction: lowering an Agent's cap is how an operator stops a bleed, and
 * a snapshot made it take effect the following Monday. The live limit is
 * therefore `min(stored, current)` — a reduction applies to the week it was
 * made in, while an increase still waits for the next period (re-opening a
 * closed-over week mid-flight would let an existing overrun be argued away).
 */
export function effectiveLimitCents(
  storedLimitCents: number,
  agentBudgetCents: number,
  weeklyLimitCents: number,
): number {
  return Math.min(
    storedLimitCents,
    periodLimitCents(agentBudgetCents, weeklyLimitCents),
  );
}

export type ReservationDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export function decideReservation(
  usage: BudgetUsage,
  amountCents: number,
): ReservationDecision {
  if (usage.overrun) {
    return {
      allowed: false,
      reason: "本周预算已超支，需等到下一个预算周期。",
    };
  }
  // A zero amount means "no per-run cap configured", which must still be an
  // admission decision. Returning `allowed` unconditionally made a workspace
  // with `maxRunCents: 0` completely ungated: every run passed, because the
  // number it was compared against was zero, and nothing ever noticed.
  if (amountCents <= 0) {
    return remainingCents(usage) > 0
      ? { allowed: true }
      : {
          allowed: false,
          reason: "本周预算已用完，需等到下一个预算周期。",
        };
  }
  const remaining = remainingCents(usage);
  if (remaining < amountCents) {
    return {
      allowed: false,
      reason: `本周剩余预算 ${remaining}c 不足以预留单次上限 ${amountCents}c。`,
    };
  }
  return { allowed: true };
}

export type SettlementInput =
  | { state: "not_contacted"; reservedCents: number }
  | { state: "known_usage"; reservedCents: number; estimatedCents: number }
  | { state: "unknown_usage"; reservedCents: number };

export type Settlement =
  | { state: "released"; settledCents: 0; unknownCents: 0; overrun: false }
  | { state: "settled"; settledCents: number; unknownCents: 0; overrun: boolean }
  | {
      state: "unknown_charged";
      settledCents: 0;
      unknownCents: number;
      overrun: false;
    };

export function planSettlement(input: SettlementInput): Settlement {
  if (input.state === "not_contacted") {
    return { state: "released", settledCents: 0, unknownCents: 0, overrun: false };
  }
  if (input.state === "unknown_usage") {
    // The request may have reached the provider: never report it as measured
    // zero, and never release the allowance it might have consumed.
    return {
      state: "unknown_charged",
      settledCents: 0,
      unknownCents: Math.max(0, input.reservedCents),
      overrun: false,
    };
  }
  const settledCents = Math.max(0, input.estimatedCents);
  return {
    state: "settled",
    settledCents,
    unknownCents: 0,
    overrun: settledCents > input.reservedCents,
  };
}

/**
 * Workspace-level view of the weekly ledger.
 *
 * The enforced cap is per Agent: each period bucket's limit is
 * min(agents.budgetCents, config.budget.weeklyLimitCents), so in one week the
 * workspace can legitimately spend the SUM of those limits. Comparing total
 * spend against a single Agent's ceiling (what the reflection insight and the
 * treasurer's line used to do) manufactures a pressure number: seven Agents each
 * comfortably inside their own cap still read as over budget, and the headroom
 * it reports is money no Agent can actually spend.
 */
export type WorkspaceBudgetInput = {
  limitCents: number;
  settledCents: number;
  unknownCents: number;
};

export type WorkspaceBudget = {
  /** Sum of the per-Agent caps this period actually enforces; 0 = no cap set. */
  limitCents: number;
  spentCents: number;
  /** spent / limitCents, NOT clamped: a real overrun has to stay visible. */
  ratio: number;
  /**
   * The Agent closest to its own cap (`index` is the row's index). An Agent with
   * no cap cannot be close to anything, so it never wins here.
   */
  tightest: {
    index: number;
    limitCents: number;
    spentCents: number;
    ratio: number;
  } | null;
};

export function workspaceBudget(rows: WorkspaceBudgetInput[]): WorkspaceBudget {
  let limitCents = 0;
  let spentCents = 0;
  let tightest: WorkspaceBudget["tightest"] = null;
  const cents = (value: number) =>
    Number.isFinite(value) ? Math.max(0, value) : 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const spent = cents(row.settledCents) + cents(row.unknownCents);
    spentCents += spent;
    if (row.limitCents <= 0) continue;
    limitCents += row.limitCents;
    const ratio = spent / row.limitCents;
    if (tightest === null || ratio > tightest.ratio) {
      tightest = { index, limitCents: row.limitCents, spentCents: spent, ratio };
    }
  }
  return {
    limitCents,
    spentCents,
    ratio: limitCents > 0 ? spentCents / limitCents : 0,
    tightest,
  };
}
