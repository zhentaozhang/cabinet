import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { auditEvents, runs, steps } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { verifyManifest } from "@/lib/domain/manifest";
import { buildManifest } from "@/server/services/commands/tasks/manifest";
import { runTask } from "@/server/services/commands/tasks/run";
import { resetDb } from "../helpers/db";

const workspace = mkdtempSync(join(tmpdir(), "cabinet-manifest-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDb();
});

async function latestRun(taskId: string) {
  const [row] = await db
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return row;
}

function verifyFile(manifestPath: string, chainPath?: string) {
  const args = ["scripts/verify-manifest.ts", manifestPath];
  if (chainPath) args.push("--chain", chainPath);
  const result = spawnSync("./node_modules/.bin/tsx", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("buildManifest", () => {
  it("describes a finished run from its stored rows", async () => {
    await runTask("tsk_read", DEMO_USER_ID);
    const run = await latestRun("tsk_read");
    expect(run).toBeDefined();

    const manifest = await buildManifest(run.id, DEMO_USER_ID);
    expect(manifest).not.toBeNull();
    if (!manifest) return;

    const rows = await db.select().from(steps).where(eq(steps.runId, run.id));
    expect(manifest.runId).toBe(run.id);
    expect(manifest.taskId).toBe("tsk_read");
    expect(manifest.userId).toBe(DEMO_USER_ID);
    expect(manifest.status).toBe(run.status);
    expect(manifest.steps).toHaveLength(rows.length);
    expect(manifest.steps.map((step) => step.idx)).toEqual(
      rows.map((row) => row.idx).sort((a, b) => a - b),
    );
    expect(manifest.promptVersion).toBeGreaterThan(0);
    expect(manifest.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.auditHead).not.toBeNull();

    const result = verifyManifest(manifest);
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(["structure", "digest", "merkle"]);
  });

  it("refuses a run that belongs to somebody else", async () => {
    await runTask("tsk_read", DEMO_USER_ID);
    const run = await latestRun("tsk_read");
    await expect(buildManifest(run.id, "usr_someone_else")).resolves.toBeNull();
  });

  it("verifies the audit anchor against the real chain", async () => {
    await runTask("tsk_read", DEMO_USER_ID);
    const run = await latestRun("tsk_read");
    const manifest = await buildManifest(run.id, DEMO_USER_ID);
    if (!manifest) throw new Error("manifest missing");

    const chain = await db
      .select({ seq: auditEvents.seq, hash: auditEvents.hash })
      .from(auditEvents)
      .where(eq(auditEvents.userId, DEMO_USER_ID));

    const result = verifyManifest(manifest, {
      chain: chain.map((row) => ({ seq: Number(row.seq), hash: row.hash })),
    });
    expect(result.ok).toBe(true);
    expect(result.checks).toContain("auditHead");
  });
});

describe("scripts/verify-manifest.ts", () => {
  it("exits 0 for an untouched manifest and 1 after a hash is rewritten", async () => {
    await runTask("tsk_read", DEMO_USER_ID);
    const run = await latestRun("tsk_read");
    const manifest = await buildManifest(run.id, DEMO_USER_ID);
    if (!manifest) throw new Error("manifest missing");

    const original = join(workspace, "original.json");
    writeFileSync(original, JSON.stringify(manifest, null, 2));

    const clean = verifyFile(original);
    expect(clean.stderr).toBe("");
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout).ok).toBe(true);

    const tampered = join(workspace, "tampered.json");
    writeFileSync(
      tampered,
      JSON.stringify(
        { ...manifest, steps: [{ ...manifest.steps[0], outputHash: "0".repeat(64) }] },
        null,
        2,
      ),
    );

    const broken = verifyFile(tampered);
    expect(broken.status).toBe(1);
    const report = JSON.parse(broken.stdout) as {
      ok: boolean;
      mismatches: { path: string }[];
    };
    expect(report.ok).toBe(false);
    expect(report.mismatches.map((entry) => entry.path)).toContain("merkleRoot");
  });

  it("checks the anchor when a chain file is supplied", async () => {
    await runTask("tsk_read", DEMO_USER_ID);
    const run = await latestRun("tsk_read");
    const manifest = await buildManifest(run.id, DEMO_USER_ID);
    if (!manifest) throw new Error("manifest missing");

    const manifestPath = join(workspace, "with-chain.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const chain = await db
      .select({ seq: auditEvents.seq, hash: auditEvents.hash })
      .from(auditEvents)
      .where(eq(auditEvents.userId, DEMO_USER_ID));
    const chainPath = join(workspace, "chain.json");
    writeFileSync(
      chainPath,
      JSON.stringify(chain.map((row) => ({ seq: Number(row.seq), hash: row.hash }))),
    );

    const result = verifyFile(manifestPath, chainPath);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).checks).toContain("auditHead");

    const wrongChainPath = join(workspace, "wrong-chain.json");
    writeFileSync(wrongChainPath, JSON.stringify([{ seq: 1, hash: "0".repeat(64) }]));
    const mismatch = verifyFile(manifestPath, wrongChainPath);
    expect(mismatch.status).toBe(1);
    expect(JSON.parse(mismatch.stdout).mismatches[0].path).toBe("auditHead");
  });
});
