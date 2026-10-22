import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import {
  applyMigrationsFrom,
  applyMigrationsUpTo,
  createScratchDatabase,
} from "../helpers/migrations";

/**
 * The audit sample floor is a nested setting, so it cannot arrive through the
 * top-level provisioning loop. This proves the data-only migration lands it on
 * a workspace that predates the setting, and leaves operator values alone.
 */

let scratchUrl = "";
let drop = async () => {};
let client: Sql;

beforeAll(async () => {
  const scratch = await createScratchDatabase();
  scratchUrl = scratch.url;
  drop = scratch.drop;
  client = postgres(scratchUrl, { max: 1, prepare: false });
  await applyMigrationsUpTo(client, "0018_agent_budget");
});

afterAll(async () => {
  await client.end();
  await drop();
});

describe("0019_autonomy_min_samples", () => {
  it("adds the sample floor and preserves operator thresholds", async () => {
    await client.unsafe(
      `INSERT INTO "policy_config" ("key", "value_json", "description")
       VALUES ('autonomy',
               '{"minTrust":52,"minSuccesses":4,"minAuditPassRate":0.8}'::jsonb,
               'legacy autonomy config')`,
    );

    const applied = await applyMigrationsFrom(
      client,
      "0018_agent_budget",
      "0019_autonomy_min_samples",
    );
    expect(applied).toContain("0019_autonomy_min_samples");

    const [row] = await client<
      { valueJson: Record<string, number> }[]
    >`SELECT "value_json" AS "valueJson" FROM "policy_config" WHERE "key" = 'autonomy'`;
    expect(row.valueJson).toEqual({
      minTrust: 52,
      minSuccesses: 4,
      minAuditPassRate: 0.8,
      minAuditSamples: 5,
    });
  });

  it("does not overwrite an existing sample floor", async () => {
    await client.unsafe(
      `UPDATE "policy_config"
       SET "value_json" = "value_json" || '{"minAuditSamples":11}'::jsonb
       WHERE "key" = 'autonomy'`,
    );
    // Re-running the statement must be idempotent for rows that already have it.
    await client.unsafe(
      `UPDATE "policy_config"
       SET "value_json" = "value_json" || '{"minAuditSamples":5}'::jsonb
       WHERE "key" = 'autonomy' AND NOT ("value_json" ? 'minAuditSamples')`,
    );

    const [row] = await client<
      { valueJson: Record<string, number> }[]
    >`SELECT "value_json" AS "valueJson" FROM "policy_config" WHERE "key" = 'autonomy'`;
    expect(row.valueJson.minAuditSamples).toBe(11);
  });
});
