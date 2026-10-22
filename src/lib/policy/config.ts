import { db } from "@/lib/db";
import { policyConfig } from "@/lib/db/schema";
import type { PolicyConfig } from "@/lib/domain/policy";
import { SEED_POLICY_CONFIG } from "@/lib/domain/policy";

const REQUIRED_KEYS = [
  "autonomy",
  "audit",
  "budget",
  "management",
  "cost",
  "council",
  "reflection",
] as const;

type ConfigKey = (typeof REQUIRED_KEYS)[number];

const DESCRIPTIONS: Record<ConfigKey, string> = {
  autonomy: "Autonomy upgrade thresholds",
  audit: "Audit streak and pass-rate window",
  budget: "Weekly budget and approval thresholds",
  management: "Estimated management minutes per decision",
  cost: "Estimated model cost per task minute",
  council: "Council role weights, score formula and quorum",
  reflection: "Reflection window, sample sizes and signal thresholds",
};

/**
 * Runtime loader. Fails closed when configuration is missing.
 * There is deliberately no code fallback here: seed data must provide it.
 */
export async function getPolicyConfig(): Promise<PolicyConfig> {
  const rows = await db.select().from(policyConfig);
  const map = new Map(rows.map((row) => [row.key, row.valueJson]));

  const missing = REQUIRED_KEYS.filter((key) => !map.has(key));
  if (missing.length > 0) {
    throw new Error(`Missing policy_config keys: ${missing.join(", ")}`);
  }

  return {
    autonomy: map.get("autonomy") as PolicyConfig["autonomy"],
    audit: map.get("audit") as PolicyConfig["audit"],
    budget: map.get("budget") as PolicyConfig["budget"],
    management: map.get("management") as PolicyConfig["management"],
    cost: map.get("cost") as PolicyConfig["cost"],
    council: map.get("council") as PolicyConfig["council"],
    reflection: map.get("reflection") as PolicyConfig["reflection"],
  };
}

/** Seed/test helper only. */
export function policyConfigSeedRows() {
  return REQUIRED_KEYS.map((key) => ({
    key,
    valueJson: SEED_POLICY_CONFIG[key],
    description: DESCRIPTIONS[key],
  }));
}
