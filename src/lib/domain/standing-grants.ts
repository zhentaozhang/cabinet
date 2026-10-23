import type { NormalizedAction } from "./policy";

/**
 * A standing policy: the user's previous "yes", turned into a bounded rule.
 *
 * The point is to stop asking the same question every week — not to hand over
 * blanket authority. So every standing policy carries its own expiry, a money
 * ceiling for spending, a use budget, and a revocation. `matchStandingGrant`
 * is pure: it never mints permission (the base grant still has to exist), it
 * only decides whether a *specific* action was already blessed.
 */
export type StandingGrant = {
  id: string;
  resource: string;
  action: string;
  /**
   * A policy only exists because a specific approval minted it. Base permission
   * grants (seeded per role, e.g. `calendar/write/*`) carry no approval and are
   * therefore never standing authority.
   */
  createdByApprovalId: string | null;
  expiresAt: Date | null;
  maxCents: number | null;
  maxRuns: number | null;
  useCount: number;
  revokedAt: Date | null;
};

export type StandingMatch = { grantId: string; reason: string } | null;

/**
 * Actions a standing policy may ever cover.
 *
 * Reads never need approval, and admin/audit/unknown must stay per-action: an
 * agent that could silently administer itself is not an agent, it is the owner.
 */
const DELEGABLE: ReadonlySet<NormalizedAction> = new Set<NormalizedAction>([
  "internal_write",
  "external_action",
  "spend",
]);

export function isDelegable(action: NormalizedAction): boolean {
  return DELEGABLE.has(action);
}

export function standingGrantState(
  grant: StandingGrant,
  now: Date,
): "active" | "revoked" | "expired" | "exhausted" {
  if (grant.revokedAt) return "revoked";
  if (grant.expiresAt && grant.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  if (grant.maxRuns !== null && grant.useCount >= grant.maxRuns) {
    return "exhausted";
  }
  return "active";
}

export function matchStandingGrant(input: {
  grants: StandingGrant[];
  resource: string;
  action: NormalizedAction;
  estimatedCostCents: number;
  now: Date;
}): StandingMatch {
  const { grants, resource, action, estimatedCostCents, now } = input;
  if (!isDelegable(action)) return null;

  const candidates = grants
    .filter((grant) => grant.createdByApprovalId !== null)
    .filter((grant) => grant.resource === resource)
    .filter((grant) => grant.action === "*" || grant.action === action)
    .filter((grant) => standingGrantState(grant, now) === "active")
    .filter((grant) => {
      // Money always needs an explicit ceiling: "same as last time" must never
      // mean "whatever it costs".
      if (action !== "spend") return true;
      return grant.maxCents !== null && estimatedCostCents <= grant.maxCents;
    })
    // Exact action beats wildcard; then the roomier remaining budget wins,
    // which keeps behaviour stable when two policies overlap.
    .sort((a, b) => {
      const exact = Number(b.action === action) - Number(a.action === action);
      if (exact !== 0) return exact;
      const aLeft = a.maxRuns === null ? Infinity : a.maxRuns - a.useCount;
      const bLeft = b.maxRuns === null ? Infinity : b.maxRuns - b.useCount;
      return bLeft - aLeft;
    });

  const grant = candidates[0];
  if (!grant) return null;

  const usage =
    grant.maxRuns === null
      ? `已用 ${grant.useCount} 次，不限次`
      : `已用 ${grant.useCount}/${grant.maxRuns} 次`;
  const expiry = grant.expiresAt
    ? `有效期至 ${grant.expiresAt.toISOString().slice(0, 10)}`
    : "长期有效";
  const ceiling =
    grant.maxCents === null ? "" : `，单次上限 ${(grant.maxCents / 100).toFixed(0)} 元`;

  return {
    grantId: grant.id,
    reason: `沿用你此前的批准（${usage}，${expiry}${ceiling}）`,
  };
}
