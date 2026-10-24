import { describe, expect, it } from "vitest";
import {
  decideReservation,
  effectiveLimitCents,
  periodLimitCents,
  planSettlement,
  remainingCents,
  usageCents,
  type BudgetUsage,
} from "@/lib/domain/agent-budget";

function usage(overrides: Partial<BudgetUsage> = {}): BudgetUsage {
  return {
    limitCents: 1000,
    reservedCents: 0,
    settledCents: 0,
    unknownCents: 0,
    overrun: false,
    ...overrides,
  };
}

describe("weekly budget limit", () => {
  it("takes the tighter of the agent cap and the weekly policy ceiling", () => {
    expect(periodLimitCents(800, 60000)).toBe(800);
    expect(periodLimitCents(0, 60000)).toBe(60000);
    expect(periodLimitCents(90000, 60000)).toBe(60000);
  });
});

describe("live limit", () => {
  it("applies a cap lowered after the period was opened", () => {
    // The bucket was opened against 1200; the Agent's cap is now 100.
    expect(effectiveLimitCents(1200, 100, 60000)).toBe(100);
  });

  it("ignores a cap raised after the period was opened until the next one", () => {
    expect(effectiveLimitCents(1200, 9000, 60000)).toBe(1200);
  });

  it("keeps the stored limit when nothing changed", () => {
    expect(effectiveLimitCents(1200, 1200, 60000)).toBe(1200);
    // A weekly ceiling tightened mid-week also bites immediately.
    expect(effectiveLimitCents(1200, 1200, 500)).toBe(500);
  });
});

describe("remaining allowance", () => {
  it("counts reserved, settled and unknown exposure together", () => {
    const u = usage({ reservedCents: 50, settledCents: 100, unknownCents: 25 });
    expect(usageCents(u)).toBe(175);
    expect(remainingCents(u)).toBe(825);
  });

  it("never reports a negative balance", () => {
    expect(remainingCents(usage({ settledCents: 1400 }))).toBe(0);
  });
});

describe("reservation decision", () => {
  it("rejects a reservation larger than the remaining allowance", () => {
    const decision = decideReservation(usage({ settledCents: 980 }), 50);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("50");
  });

  it("allows a reservation that exactly fits", () => {
    expect(decideReservation(usage({ settledCents: 950 }), 50).allowed).toBe(true);
  });

  it("still refuses a zero-amount admission once the week is spent", () => {
    // `maxRunCents: 0` means "no per-run cap", not "no gate": a hold of 0 used
    // to be allowed unconditionally, which made the budget ledger advisory.
    const spent = usage({ settledCents: 1000 });
    const decision = decideReservation(spent, 0);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("用完");

    expect(decideReservation(usage({ settledCents: 999 }), 0).allowed).toBe(true);
  });

  it("blocks everything once the period is in overrun", () => {
    const decision = decideReservation(
      usage({ settledCents: 1200, overrun: true }),
      1,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("超支");
  });
});

describe("settlement", () => {
  it("releases the whole reservation when the provider was never contacted", () => {
    expect(
      planSettlement({ state: "not_contacted", reservedCents: 50 }),
    ).toEqual({ state: "released", settledCents: 0, unknownCents: 0, overrun: false });
  });

  it("settles known usage to the estimate and releases the remainder", () => {
    expect(
      planSettlement({ state: "known_usage", reservedCents: 50, estimatedCents: 18 }),
    ).toEqual({ state: "settled", settledCents: 18, unknownCents: 0, overrun: false });
  });

  it("records the full estimate and an overrun when it exceeds the reservation", () => {
    expect(
      planSettlement({ state: "known_usage", reservedCents: 50, estimatedCents: 90 }),
    ).toEqual({ state: "settled", settledCents: 90, unknownCents: 0, overrun: true });
  });

  it("charges the full reservation as unknown exposure when usage is unavailable", () => {
    expect(
      planSettlement({ state: "unknown_usage", reservedCents: 50 }),
    ).toEqual({
      state: "unknown_charged",
      settledCents: 0,
      unknownCents: 50,
      overrun: false,
    });
  });
});
