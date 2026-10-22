import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { policyConfig } from "@/lib/db/schema";
import { getPolicyConfig } from "@/lib/policy/config";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("policy config validation", () => {
  it("loads the seeded config", async () => {
    const config = await getPolicyConfig();
    expect(config.cost.maxOutputTokens).toBeGreaterThan(0);
    expect(config.council.minPositions).toBeGreaterThan(0);
  });

  it("rejects a config row with the wrong shape", async () => {
    await db
      .update(policyConfig)
      .set({
        valueJson: {
          perMinuteCents: 2,
          centsPer1kTokens: 0.8,
        },
      })
      .where(eq(policyConfig.key, "cost"));

    await expect(getPolicyConfig()).rejects.toThrow(/Invalid policy_config/);
  });

  it("rejects a negative cost cap", async () => {
    await db
      .update(policyConfig)
      .set({
        valueJson: {
          perMinuteCents: 2,
          centsPer1kTokens: 0.8,
          maxOutputTokens: 1200,
          maxRunCents: -1,
        },
      })
      .where(eq(policyConfig.key, "cost"));

    await expect(getPolicyConfig()).rejects.toThrow(/Invalid policy_config/);
  });
});
