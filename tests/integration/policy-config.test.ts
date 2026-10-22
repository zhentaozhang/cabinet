import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, policyConfig, users } from "@/lib/db/schema";
import { getPolicyConfig } from "@/lib/policy/config";
import { setupWorkspace } from "@/lib/setup";
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

  it("fails closed when the autonomy sample floor is missing", async () => {
    await db
      .update(policyConfig)
      .set({
        valueJson: {
          minTrust: 70,
          minSuccesses: 3,
          minAuditPassRate: 0.9,
        },
      })
      .where(eq(policyConfig.key, "autonomy"));

    // This is why 0019_autonomy_min_samples exists: a missing nested key must
    // not silently default, and it must not brick an existing workspace.
    await expect(getPolicyConfig()).rejects.toThrow(/Invalid policy_config/);
  });
});

describe("policy config backfill", () => {
  it("merges a missing nested key without touching operator values", async () => {
    await db
      .update(policyConfig)
      .set({
        valueJson: {
          minTrust: 52,
          minSuccesses: 4,
          minAuditPassRate: 0.8,
        },
      })
      .where(eq(policyConfig.key, "autonomy"));

    await db.insert(users).values({
      id: "usr_backfill",
      email: "backfill@example.com",
      name: "Backfill",
    });

    await setupWorkspace({ userId: "usr_backfill", timezone: "Asia/Shanghai" });

    const [row] = await db
      .select({ valueJson: policyConfig.valueJson })
      .from(policyConfig)
      .where(eq(policyConfig.key, "autonomy"));
    expect(row.valueJson).toEqual({
      minTrust: 52,
      minSuccesses: 4,
      minAuditPassRate: 0.8,
      minAuditSamples: 5,
    });

    const created = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.userId, "usr_backfill"));
    expect(created.length).toBeGreaterThan(0);
  });
});
