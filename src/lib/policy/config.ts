import { cache } from "react";
import { z } from "zod";
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
  "dissent",
  "learning",
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
  dissent: "Dissent vindication trust bonus and chief deviation penalty",
  learning: "Learning progress weights and next-task policy",
};


const scoreSchema = z.object({
  feasibility: z.number(),
  costEfficiency: z.number(),
  evidenceQuality: z.number(),
  robustness: z.number(),
});

const policyConfigSchema = z.object({
  autonomy: z.object({
    minTrust: z.number(),
    minSuccesses: z.number(),
    minAuditPassRate: z.number(),
    minAuditSamples: z.number().int().min(1),
  }),
  audit: z.object({
    rejectStreakLimit: z.number(),
    passRateWindow: z.number(),
  }),
  budget: z.object({
    weeklyLimitCents: z.number(),
    approvalThresholdCents: z.number(),
  }),
  management: z.object({ minutesPerDecision: z.number() }),
  cost: z.object({
    perMinuteCents: z.number(),
    centsPer1kTokens: z.number(),
    maxOutputTokens: z.number().int().positive(),
    // `0` is a supported value: "no per-run cap". It no longer disables
    // accounting — run.ts always writes a hold — but the schema still refuses
    // fractional cents and negatives.
    maxRunCents: z.number().int().nonnegative(),
  }),
  council: z.object({
    roleWeights: z.record(z.string(), z.number()),
    dimensionWeights: scoreSchema,
    score: z.object({
      base: z.number(),
      goalWeight: z.number(),
      trustWeight: z.number(),
      evidencePoints: z.number(),
      rejectPenalty: z.number(),
      pausePenalty: z.number(),
      budgetPressureWeight: z.number(),
    }),
    minPositions: z.number().int().positive(),
    minEnergy: z.number(),
    dissentWindowDays: z.number().int().positive(),
    dissentBudgetRatio: z.number(),
  }),
  reflection: z.object({
    windowDays: z.number().int().positive(),
    minRejectEvents: z.number().int().nonnegative(),
    minTaskSample: z.number().int().nonnegative(),
    eveningHour: z.number().int().min(0).max(23),
    eveningCompletionThreshold: z.number(),
    lowEnergyThreshold: z.number(),
    budgetPressureRatio: z.number(),
    confidence: z.number(),
  }),
  dissent: z.object({
    trustBonus: z.number(),
    chiefPenalty: z.number(),
    precedentSalience: z.number(),
  }),
  learning: z.object({
    progressWeights: z.object({
      acceptedTasks: z.number().nonnegative(),
      recall: z.number().nonnegative(),
      checkins: z.number().nonnegative(),
    }),
    targetCheckinsPerWeek: z.number().int().positive(),
    nextTask: z.object({
      estimateMin: z.number().int().positive(),
      minRecallScore: z.number().min(0).max(1),
      minWords: z.number().int().positive(),
      maxErrorTags: z.number().int().positive(),
      retestAfterDays: z.number().int().positive(),
    }),
  }),
});

/**
 * Runtime loader. Fails closed when configuration is missing.
 * There is deliberately no code fallback here: seed data must provide it.
 *
 * Wrapped in React `cache` so a single render/route that asks for the policy
 * several times (page payload + weekly metrics + a command) reads the table
 * once. Outside a request scope `cache` simply calls through, so services and
 * tests keep the per-call behaviour.
 */
export const getPolicyConfig = cache(
  async (): Promise<PolicyConfig> => {
    const rows = await db.select().from(policyConfig);
    const map = new Map(rows.map((row) => [row.key, row.valueJson]));

    const missing = REQUIRED_KEYS.filter((key) => !map.has(key));
    if (missing.length > 0) {
      throw new Error(`Missing policy_config keys: ${missing.join(", ")}`);
    }

    const candidate = {
      autonomy: map.get("autonomy"),
      audit: map.get("audit"),
      budget: map.get("budget"),
      management: map.get("management"),
      cost: map.get("cost"),
      council: map.get("council"),
      reflection: map.get("reflection"),
      dissent: map.get("dissent"),
      learning: map.get("learning"),
    };
    const parsed = policyConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid policy_config: ${detail}`);
    }
    return parsed.data as PolicyConfig;
  },
);

/** Seed/test helper only. */
export function policyConfigSeedRows() {
  return REQUIRED_KEYS.map((key) => ({
    key,
    valueJson: SEED_POLICY_CONFIG[key],
    description: DESCRIPTIONS[key],
  }));
}
