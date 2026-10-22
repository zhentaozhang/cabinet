import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { policyConfig } from "@/lib/db/schema";
import { SEED_POLICY_CONFIG } from "@/lib/domain/policy";
import {
  POLICY_KEYS,
  mergeMissingKeys,
  syncPolicyConfig,
} from "@/lib/policy/sync";
import { resetDb } from "../helpers/db";

async function readGroup(key: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ valueJson: policyConfig.valueJson })
    .from(policyConfig)
    .where(eq(policyConfig.key, key));
  return row.valueJson as Record<string, unknown>;
}

describe("POLICY_KEYS", () => {
  // A group added to the seed but not to POLICY_KEYS would be skipped by the
  // maintenance command and keep answering 500 on every page.
  it("covers every seeded policy group", () => {
    expect([...POLICY_KEYS].sort()).toEqual(
      Object.keys(SEED_POLICY_CONFIG).sort(),
    );
  });
});

describe("mergeMissingKeys", () => {
  it("adds only missing keys and keeps operator values", () => {
    const merged = mergeMissingKeys(
      { a: 1, nested: { keep: "mine" } },
      { a: 99, b: 2, nested: { keep: "seed", add: true } },
    );
    expect(merged).toEqual({ a: 1, b: 2, nested: { keep: "mine", add: true } });
  });

  it("returns null when nothing is missing", () => {
    expect(mergeMissingKeys({ a: 1 }, { a: 2 })).toBeNull();
  });
});

describe("syncPolicyConfig", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("reports nothing on a complete workspace and writes no rows", async () => {
    const before = await db.select().from(policyConfig);
    const report = await syncPolicyConfig();

    expect(report.inserted).toEqual([]);
    expect(report.patched).toEqual([]);
    expect(report.unchanged.length).toBeGreaterThan(0);

    const after = await db.select().from(policyConfig);
    expect(after.map((row) => row.updatedAt.toISOString())).toEqual(
      before.map((row) => row.updatedAt.toISOString()),
    );
  });

  it("restores a setting added to an existing group, keeping operator values", async () => {
    const drifted = { ...SEED_POLICY_CONFIG.autonomy } as Record<string, unknown>;
    delete drifted.minAuditSamples;
    drifted.minTrust = 42;
    await db
      .update(policyConfig)
      .set({ valueJson: drifted })
      .where(eq(policyConfig.key, "autonomy"));

    // A dry run must diagnose without writing.
    const planned = await syncPolicyConfig(undefined, { dryRun: true });
    expect(planned.patched).toEqual([
      { key: "autonomy", added: ["minAuditSamples"] },
    ]);
    expect(await readGroup("autonomy")).not.toHaveProperty("minAuditSamples");

    const report = await syncPolicyConfig();
    expect(report.patched).toEqual([
      { key: "autonomy", added: ["minAuditSamples"] },
    ]);

    const repaired = await readGroup("autonomy");
    expect(repaired.minAuditSamples).toBe(SEED_POLICY_CONFIG.autonomy.minAuditSamples);
    expect(repaired.minTrust).toBe(42);
  });

  it("creates a whole missing group", async () => {
    await db.delete(policyConfig).where(eq(policyConfig.key, "learning"));

    const report = await syncPolicyConfig();
    expect(report.inserted).toEqual(["learning"]);
    expect(await readGroup("learning")).toEqual(SEED_POLICY_CONFIG.learning);
  });

  it("is idempotent", async () => {
    await db.delete(policyConfig).where(eq(policyConfig.key, "dissent"));
    await syncPolicyConfig();

    const second = await syncPolicyConfig();
    expect(second.inserted).toEqual([]);
    expect(second.patched).toEqual([]);
  });
});
