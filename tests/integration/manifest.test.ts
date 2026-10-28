import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { approvals, auditEvents, evidence, runs, steps } from "@/lib/db/schema";
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
    // A demo draft never went through the prompt template, so the manifest
    // records that rather than quoting whichever template this build ships.
    expect(manifest.promptVersion).toBeNull();
    expect(manifest.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.auditHead).not.toBeNull();

    const result = verifyManifest(manifest);
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(["structure", "digest", "merkle"]);
  });

  it("reports the prompt version the run recorded, not the one this build ships", async () => {
    await runTask("tsk_read", DEMO_USER_ID);
    const run = await latestRun("tsk_read");
    // A run produced by an older build. Its row is the only place its template
    // can come from, so re-exporting it must not adopt today's constant — that
    // would also mint a new digest for an unchanged run.
    await db.update(runs).set({ promptVersion: 7 }).where(eq(runs.id, run.id));

    const manifest = await buildManifest(run.id, DEMO_USER_ID);
    expect(manifest?.promptVersion).toBe(7);
    if (!manifest) return;
    expect(verifyManifest(manifest).ok).toBe(true);
  });

  it("carries a not-judged acceptance item as undetermined, not as a failure", async () => {
    await runTask("tsk_read", DEMO_USER_ID);
    const run = await latestRun("tsk_read");
    // An audit is its own run; the manifest reads the newest audit step of the
    // task. Seed exactly the row the auditor writes when criteria are prose.
    await db.insert(steps).values({
      id: "stp_undet",
      runId: run.id,
      idx: 99,
      type: "audit",
      input: {},
      output: {
        pass: true,
        reason: "产物已提交；验收没有逐条对照，结论待你确认。",
        checklist: [
          {
            item: { type: "manual", note: "45 分钟专注；3 行笔记", required: true },
            passed: false,
            undetermined: true,
            reason: "需要你人工判定",
          },
        ],
      },
    });

    const manifest = await buildManifest(run.id, DEMO_USER_ID);
    if (!manifest) throw new Error("manifest missing");
    expect(manifest.acceptance).toHaveLength(1);
    expect(manifest.acceptance[0]!.verdict).toBe("undetermined");
    expect(manifest.acceptance[0]!.undetermined).toBe(true);
    expect(verifyManifest(manifest).ok).toBe(true);
  });

  it("lists only the approvals that belong to the run it describes", async () => {
    await runTask("tsk_read", DEMO_USER_ID);
    const run = await latestRun("tsk_read");

    // runId carries no foreign key, so a stale value is exactly what a reviewer
    // would see: an approval written for another run of the same task.
    await db.insert(approvals).values([
      {
        id: "appr_task_level",
        userId: DEMO_USER_ID,
        taskId: "tsk_read",
        runId: null,
        action: "publish",
        payload: {},
        status: "approved",
        decidedAt: new Date("2026-10-01T00:00:00Z"),
        createdAt: new Date("2026-10-01T00:00:00Z"),
      },
      {
        id: "appr_this_run",
        userId: DEMO_USER_ID,
        taskId: "tsk_read",
        runId: run.id,
        action: "publish",
        payload: {},
        status: "approved",
        decidedAt: new Date("2026-10-02T00:00:00Z"),
        createdAt: new Date("2026-10-02T00:00:00Z"),
      },
      {
        id: "appr_other_run",
        userId: DEMO_USER_ID,
        taskId: "tsk_read",
        runId: "run_somewhere_else",
        action: "publish",
        payload: {},
        status: "approved",
        decidedAt: new Date("2026-10-03T00:00:00Z"),
        createdAt: new Date("2026-10-03T00:00:00Z"),
      },
    ]);

    const manifest = await buildManifest(run.id, DEMO_USER_ID);
    if (!manifest) throw new Error("manifest missing");
    expect(manifest.approvals.map((entry) => entry.id)).toEqual([
      "appr_task_level",
      "appr_this_run",
    ]);
    expect(verifyManifest(manifest).ok).toBe(true);
  });

  it("picks the same audit verdict when two share a timestamp", async () => {
    // Every row written by one transaction shares now(), so the audit steps of
    // two audits ran at the same instant have no ordering by time alone. The id
    // is the tie-break; without it the same run could export two digests.
    await runTask("tsk_read", DEMO_USER_ID);
    const run = await latestRun("tsk_read");
    const stamp = new Date("2026-10-05T00:00:00Z");
    for (const [offset, id, passed] of [
      [0, "stp_audit_a", false],
      [1, "stp_audit_z", true],
    ] as const) {
      await db.insert(steps).values({
        id,
        runId: run.id,
        idx: 900 + offset,
        type: "audit",
        input: {},
        output: { checklist: [{ text: "有引用", passed, undetermined: false }] },
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        createdAt: stamp,
      });
    }

    const manifest = await buildManifest(run.id, DEMO_USER_ID);
    if (!manifest) throw new Error("manifest missing");
    // The higher id wins the tie, so the verdict is the one from stp_audit_z.
    expect(manifest.acceptance[0]?.verdict).toBe("pass");
    expect(verifyManifest(manifest).ok).toBe(true);
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

/**
 * 同一次检索返回的多条证据写在同一条 insert 里，created_at 因此完全相同
 * （now() 是事务时间）。只按 created_at 排序时，谁在前取决于物理行序：
 * 同一份 run 两次导出会得到不同的证据顺序，摘要也就跟着变。
 */
describe("buildManifest 的确定性", () => {
  it("orders evidence by a stable key instead of where the row happens to sit", async () => {
    await runTask("tsk_read", DEMO_USER_ID);
    const run = await latestRun("tsk_read");
    const retrievedAt = new Date();

    await db.insert(evidence).values(
      ["evd_tie_c", "evd_tie_a", "evd_tie_b"].map((id) => ({
        id,
        userId: DEMO_USER_ID,
        taskId: "tsk_read",
        runId: run.id,
        kind: "web_page",
        url: `https://example.com/${id}`,
        title: id,
        quote: "检索片段",
        provider: "stub",
        contentHash: `hash-${id}`,
        retrievedAt,
      })),
    );

    const first = await buildManifest(run.id, DEMO_USER_ID);
    if (!first) throw new Error("manifest missing");
    expect(first.evidence.map((item) => item.id)).toEqual([
      "evd_tie_a",
      "evd_tie_b",
      "evd_tie_c",
    ]);

    // title 不在摘要里。改它不该改变同一份 run 的摘要；可如果顺序来自物理行序，
    // 一次 UPDATE 把这一行挪到堆尾，摘要就会变——那是"翻新了行"而不是"改了内容"。
    await db
      .update(evidence)
      .set({ title: "改过的标题" })
      .where(eq(evidence.id, "evd_tie_a"));
    const second = await buildManifest(run.id, DEMO_USER_ID);
    if (!second) throw new Error("manifest missing");
    expect(second.evidence.map((item) => item.id)).toEqual(
      first.evidence.map((item) => item.id),
    );
    expect(second.digest).toBe(first.digest);
  });
});
