import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { policyConfig } from "@/lib/db/schema";
import { SEED_POLICY_CONFIG } from "@/lib/domain/policy";

/**
 * Policy keys the workspace needs to exist at all.
 *
 * Kept next to the sync routine (not in setup) because the maintenance command
 * has to create the same rows a fresh workspace gets.
 */
export const POLICY_KEYS = [
  "autonomy",
  "audit",
  "budget",
  "management",
  "cost",
  "council",
  "reflection",
  "dissent",
  "learning",
] as const;

export type PolicyKey = (typeof POLICY_KEYS)[number];

export type PolicySyncReport = {
  /** Whole policy groups that were missing and got created. */
  inserted: PolicyKey[];
  /** Groups that existed but were missing nested settings. */
  patched: Array<{ key: PolicyKey; added: string[] }>;
  /** Groups already complete. */
  unchanged: PolicyKey[];
};

/** A transaction handle or the pooled client — both support the two writes. */
type Client = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Returns a merged copy of `stored` that gains every key present in `seed` but
 * missing from `stored`, recursively. Returns null when nothing is missing so
 * callers can skip the write. Existing operator values always win.
 */
export function mergeMissingKeys(
  stored: unknown,
  seed: unknown,
): Record<string, unknown> | null {
  if (
    typeof stored !== "object" ||
    stored === null ||
    Array.isArray(stored) ||
    typeof seed !== "object" ||
    seed === null ||
    Array.isArray(seed)
  ) {
    return null;
  }
  const target = { ...(stored as Record<string, unknown>) };
  let changed = false;
  for (const [key, seedValue] of Object.entries(seed as Record<string, unknown>)) {
    if (!(key in target)) {
      target[key] = seedValue;
      changed = true;
      continue;
    }
    const nested = mergeMissingKeys(target[key], seedValue);
    if (nested !== null) {
      target[key] = nested;
      changed = true;
    }
  }
  return changed ? target : null;
}

/** Which dotted paths did `after` gain relative to `before`? */
function addedPaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (
    typeof before !== "object" ||
    before === null ||
    Array.isArray(before) ||
    typeof after !== "object" ||
    after === null ||
    Array.isArray(after)
  ) {
    return [];
  }
  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, value] of Object.entries(afterRecord)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in beforeRecord)) out.push(path);
    else out.push(...addedPaths(beforeRecord[key], value, path));
  }
  return out;
}

/**
 * Bring `policy_config` up to the shape the running build expects.
 *
 * Settings added to an existing group never get their own migration, and
 * `getPolicyConfig()` fails closed on a missing key — so a workspace created
 * before a new setting existed would answer every page with a 500. This routine
 * only ever *adds* keys; operator-modified values are left untouched, which
 * makes it safe to run on any environment, any number of times.
 */
export async function syncPolicyConfig(
  client: Client = db,
  options: { dryRun?: boolean } = {},
): Promise<PolicySyncReport> {
  const dryRun = options.dryRun === true;
  const rows = await client
    .select({ key: policyConfig.key, valueJson: policyConfig.valueJson })
    .from(policyConfig);
  const existing = new Map(rows.map((row) => [row.key, row.valueJson]));

  const report: PolicySyncReport = {
    inserted: [],
    patched: [],
    unchanged: [],
  };

  for (const key of POLICY_KEYS) {
    const seed = SEED_POLICY_CONFIG[key];
    if (!existing.has(key)) {
      if (!dryRun) await client.insert(policyConfig).values({
        key,
        valueJson: seed,
        description: `Cabinet policy: ${key}`,
      });
      report.inserted.push(key);
      continue;
    }

    const stored = existing.get(key);
    const merged = mergeMissingKeys(stored, seed);
    if (merged === null) {
      report.unchanged.push(key);
      continue;
    }

    if (!dryRun) {
      await client
        .update(policyConfig)
        .set({ valueJson: merged, updatedAt: new Date() })
        .where(eq(policyConfig.key, key));
    }
    report.patched.push({ key, added: addedPaths(stored, merged) });
  }

  return report;
}
