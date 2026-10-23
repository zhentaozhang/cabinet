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
  /** The user's zone, so an expiry date is not shown a day off. */
  timeZone?: string;
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
    /**
     * Exact action beats wildcard; then the TIGHTEST remaining budget wins.
     * When two policies overlap, honouring the narrower one keeps the granted
     * authority as small as the user's most cautious answer.
     */
    .sort((a, b) => {
      const exact = Number(b.action === action) - Number(a.action === action);
      if (exact !== 0) return exact;
      const aLeft = a.maxRuns === null ? Number.MAX_SAFE_INTEGER : a.maxRuns - a.useCount;
      const bLeft = b.maxRuns === null ? Number.MAX_SAFE_INTEGER : b.maxRuns - b.useCount;
      if (aLeft !== bLeft) return aLeft - bLeft;
      // Then the smaller money ceiling, for the same reason.
      const aCap = a.maxCents === null ? Number.MAX_SAFE_INTEGER : a.maxCents;
      const bCap = b.maxCents === null ? Number.MAX_SAFE_INTEGER : b.maxCents;
      return aCap - bCap;
    });

  const grant = candidates[0];
  if (!grant) return null;

  const usage =
    grant.maxRuns === null
      ? `已用 ${grant.useCount} 次，不限次`
      : `已用 ${grant.useCount}/${grant.maxRuns} 次`;
  const expiry = grant.expiresAt
    ? `有效期至 ${localDate(grant.expiresAt, input.timeZone)}`
    : "长期有效";
  const ceiling =
    grant.maxCents === null
      ? ""
      : `，单次上限 ${(grant.maxCents / 100).toFixed(2)} 元`;

  return {
    grantId: grant.id,
    reason: `沿用你此前的批准（${usage}，${expiry}${ceiling}）`,
  };
}

/** YYYY-MM-DD in the user's zone; UTC would show the previous day east of it. */
function localDate(at: Date, timeZone?: string): string {
  if (!timeZone) return at.toISOString().slice(0, 10);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
