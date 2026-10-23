import { describe, expect, it } from "vitest";

import type { NormalizedAction } from "@/lib/domain/policy";
import {
  matchStandingGrant,
  type StandingGrant,
} from "@/lib/domain/standing-grants";

const now = new Date("2026-10-23T10:00:00Z");

const policy = (over: Partial<StandingGrant> = {}): StandingGrant => ({
  id: "grt_1",
  resource: "calendar",
  action: "external_action",
  createdByApprovalId: "appr_1",
  expiresAt: new Date("2026-11-22T10:00:00Z"),
  maxCents: null,
  maxRuns: 10,
  useCount: 0,
  revokedAt: null,
  ...over,
});

describe("matchStandingGrant", () => {
  it("matches the class of action the user approved", () => {
    const match = matchStandingGrant({
      grants: [policy()],
      resource: "calendar",
      action: "external_action",
      estimatedCostCents: 0,
      now,
    });
    expect(match?.grantId).toBe("grt_1");
  });

  it("never treats a base permission grant as standing authority", () => {
    expect(
      matchStandingGrant({
        grants: [
          policy({
            id: "grt_base",
            action: "*",
            createdByApprovalId: null,
            maxRuns: null,
          }),
        ],
        resource: "calendar",
        action: "external_action",
        estimatedCostCents: 0,
        now,
      }),
    ).toBeNull();
  });

  it("never matches a different action class", () => {
    expect(
      matchStandingGrant({
        grants: [policy()],
        resource: "calendar",
        action: "spend",
        estimatedCostCents: 0,
        now,
      }),
    ).toBeNull();
  });

  it("never matches another resource, even with a wildcard-ish name", () => {
    expect(
      matchStandingGrant({
        grants: [policy({ resource: "calendar" })],
        resource: "ledger",
        action: "external_action",
        estimatedCostCents: 0,
        now,
      }),
    ).toBeNull();
  });

  it("honours a wildcard action, but a wildcard still cannot spend uncapped", () => {
    expect(
      matchStandingGrant({
        grants: [policy({ action: "*" })],
        resource: "calendar",
        action: "external_action",
        estimatedCostCents: 0,
        now,
      })?.grantId,
    ).toBe("grt_1");

    expect(
      matchStandingGrant({
        grants: [policy({ action: "*" })],
        resource: "calendar",
        action: "spend",
        estimatedCostCents: 500,
        now,
      }),
    ).toBeNull();

    expect(
      matchStandingGrant({
        grants: [policy({ action: "*", maxCents: 2_000 })],
        resource: "calendar",
        action: "spend",
        estimatedCostCents: 500,
        now,
      })?.grantId,
    ).toBe("grt_1");
  });

  it("is dead once revoked", () => {
    expect(
      matchStandingGrant({
        grants: [policy({ revokedAt: new Date("2026-10-23T09:00:00Z") })],
        resource: "calendar",
        action: "external_action",
        estimatedCostCents: 0,
        now,
      }),
    ).toBeNull();
  });

  it("is dead once expired, inclusive at the boundary", () => {
    expect(
      matchStandingGrant({
        grants: [policy({ expiresAt: new Date("2026-10-23T09:59:59Z") })],
        resource: "calendar",
        action: "external_action",
        estimatedCostCents: 0,
        now,
      }),
    ).toBeNull();
    expect(
      matchStandingGrant({
        grants: [policy({ expiresAt: new Date("2026-10-23T10:00:00Z") })],
        resource: "calendar",
        action: "external_action",
        estimatedCostCents: 0,
        now,
      }),
    ).toBeNull();
  });

  it("is dead once its use budget is spent", () => {
    expect(
      matchStandingGrant({
        grants: [policy({ maxRuns: 3, useCount: 3 })],
        resource: "calendar",
        action: "external_action",
        estimatedCostCents: 0,
        now,
      }),
    ).toBeNull();
    expect(
      matchStandingGrant({
        grants: [policy({ maxRuns: 3, useCount: 2 })],
        resource: "calendar",
        action: "external_action",
        estimatedCostCents: 0,
        now,
      })?.grantId,
    ).toBe("grt_1");
  });

  it("refuses spending without an explicit ceiling", () => {
    expect(
      matchStandingGrant({
        grants: [policy({ action: "spend", maxCents: null })],
        resource: "calendar",
        action: "spend",
        estimatedCostCents: 1_000,
        now,
      }),
    ).toBeNull();
  });

  it("caps spending at the ceiling the user set", () => {
    expect(
      matchStandingGrant({
        grants: [policy({ action: "spend", maxCents: 5_000 })],
        resource: "calendar",
        action: "spend",
        estimatedCostCents: 5_000,
        now,
      })?.grantId,
    ).toBe("grt_1");
    expect(
      matchStandingGrant({
        grants: [policy({ action: "spend", maxCents: 5_000 })],
        resource: "calendar",
        action: "spend",
        estimatedCostCents: 5_001,
        now,
      }),
    ).toBeNull();
  });

  it("never covers admin, audit, read or unknown actions", () => {
    for (const action of ["admin", "audit", "internal_read", "unknown"] as NormalizedAction[]) {
      expect(
        matchStandingGrant({
          grants: [policy({ action: "*" })],
          resource: "calendar",
          action,
          estimatedCostCents: 0,
          now,
        }),
        action,
      ).toBeNull();
    }
  });

  it("prefers the most specific policy and explains itself", () => {
    const match = matchStandingGrant({
      grants: [
        policy({ id: "grt_wild", action: "*" }),
        policy({ id: "grt_exact", action: "external_action", maxRuns: 4, useCount: 1 }),
      ],
      resource: "calendar",
      action: "external_action",
      estimatedCostCents: 0,
      now,
    });
    expect(match?.grantId).toBe("grt_exact");
    expect(match?.reason).toContain("1/4");
  });
});

describe("overlapping policies", () => {
  it("honours the tightest remaining budget, not the roomiest", () => {
    const match = matchStandingGrant({
      grants: [
        policy({ id: "grt_wide", maxRuns: 50, useCount: 0 }),
        policy({ id: "grt_narrow", maxRuns: 5, useCount: 0 }),
      ],
      resource: "calendar",
      action: "external_action",
      estimatedCostCents: 0,
      now,
    });
    expect(match?.grantId).toBe("grt_narrow");
  });

  it("shows the expiry in the user's zone instead of UTC", () => {
    const match = matchStandingGrant({
      grants: [policy({ expiresAt: new Date("2026-11-22T20:00:00Z") })],
      resource: "calendar",
      action: "external_action",
      estimatedCostCents: 0,
      now,
      timeZone: "Asia/Shanghai",
    });
    // 20:00Z is already the next day in +08:00.
    expect(match?.reason).toContain("2026-11-23");
  });
});
