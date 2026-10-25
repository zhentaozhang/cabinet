import { describe, expect, it } from "vitest";

import { sha256 } from "@/lib/ids";
import {
  MANIFEST_VERSION,
  leafHash,
  merkleRoot,
  verifyManifest,
  type RunManifest,
} from "@/lib/domain/manifest";

function hex(char: string): string {
  return char.repeat(64);
}

type Step = RunManifest["steps"][number];

function step(idx: number, outputHash = hex(String(idx % 10))): Step {
  return { idx, type: "tool", tool: "read_notes", inputHash: hex("1"), outputHash };
}

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  const steps = overrides.steps ?? [step(0), step(1)];
  return {
    version: MANIFEST_VERSION,
    runId: "run_1",
    taskId: "tsk_1",
    agentId: "ag_1",
    userId: "usr_1",
    status: "succeeded",
    createdAt: "2026-10-25T00:00:00.000Z",
    model: { provider: "openai", model: "gpt-4.1-mini" },
    promptVersion: 1,
    steps,
    artifacts: [{ id: "art_1", sha256: hex("a") }],
    evidence: [{ id: "evd_1", contentHash: hex("b") }],
    acceptance: [{ item: { type: "min_words" }, verdict: "pass", undetermined: false }],
    acceptanceRunId: "run_audit",
    approvals: [{ id: "apr_1", action: "send_email", status: "approved", decidedAt: null }],
    auditHead: { seq: 12, hash: hex("c") },
    merkleRoot: merkleRoot(steps.map((entry) => leafHash(entry))),
    ...overrides,
  };
}

describe("merkleRoot", () => {
  it("returns null for no leaves", () => {
    expect(merkleRoot([])).toBeNull();
  });

  it("returns the leaf itself for a single step", () => {
    expect(merkleRoot(["abc"])).toBe("abc");
  });

  it("hashes a pair in sorted order so order of arguments cannot matter", () => {
    expect(merkleRoot(["aa", "bb"])).toBe(sha256("aabb"));
    expect(merkleRoot(["bb", "aa"])).toBe(sha256("aabb"));
  });

  it("promotes an odd tail instead of duplicating it", () => {
    const promoted = merkleRoot(["aa", "bb", "cc"]);
    const duplicated = sha256(sha256("aabb") + sha256("cccc"));
    expect(promoted).toBe(sha256(sha256("aabb") + "cc"));
    expect(promoted).not.toBe(duplicated);
  });
});

describe("leafHash", () => {
  it("ignores key insertion order", () => {
    const a = leafHash({ idx: 1, type: "tool", tool: null, inputHash: hex("1"), outputHash: hex("a") });
    const b = leafHash({
      outputHash: hex("a"),
      inputHash: hex("1"),
      tool: null,
      type: "tool",
      idx: 1,
    } as never);
    expect(a).toBe(b);
  });

  it("changes when only the input changes", () => {
    const base = { idx: 0, type: "tool", tool: null, outputHash: hex("a") };
    expect(leafHash({ ...base, inputHash: hex("1") })).not.toBe(
      leafHash({ ...base, inputHash: hex("2") }),
    );
  });

  it("changes when the stored output changes", () => {
    expect(leafHash(step(0, hex("a")))).not.toBe(leafHash(step(0, hex("b"))));
  });
});

describe("verifyManifest", () => {
  it("accepts an intact manifest and leaves the anchor unchecked without a chain", () => {
    const result = verifyManifest(manifest());
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(["structure", "merkle"]);
    expect(result.unchecked).toEqual(["auditHead"]);
    expect(result.mismatches).toEqual([]);
  });

  it("reports a null anchor as unchecked rather than verified", () => {
    const result = verifyManifest(manifest({ auditHead: null }), {
      chain: [{ seq: 12, hash: hex("c") }],
    });
    expect(result.ok).toBe(true);
    expect(result.unchecked).toEqual(["auditHead"]);
    expect(result.checks).not.toContain("auditHead");
  });

  it("verifies the audit anchor when the chain is supplied", () => {
    const result = verifyManifest(manifest(), {
      chain: [{ seq: 11, hash: hex("e") }, { seq: 12, hash: hex("c") }],
    });
    expect(result.ok).toBe(true);
    expect(result.checks).toContain("auditHead");
  });

  it("rejects an anchor the chain does not contain", () => {
    const result = verifyManifest(manifest(), { chain: [{ seq: 12, hash: hex("f") }] });
    expect(result.ok).toBe(false);
    expect(result.mismatches.map((entry) => entry.path)).toEqual(["auditHead"]);
  });

  it("detects a rewritten step output", () => {
    const tampered = manifest();
    tampered.steps[1] = { ...tampered.steps[1], outputHash: hex("9") };
    const result = verifyManifest(tampered);
    expect(result.ok).toBe(false);
    expect(result.mismatches.map((entry) => entry.path)).toContain("merkleRoot");
  });

  it("rejects a hash that is not 64 lowercase hex characters", () => {
    const bad = manifest({ steps: [step(0), { ...step(1), outputHash: "not-a-hash" }] });
    const result = verifyManifest(bad);
    expect(result.ok).toBe(false);
    expect(result.mismatches.map((entry) => entry.path)).toContain("steps[1].outputHash");
  });

  it("does not claim the structure check when a hash is malformed", () => {
    const bad = manifest({ steps: [step(0), { ...step(1), outputHash: "not-a-hash" }] });
    const result = verifyManifest(bad);
    expect(result.ok).toBe(false);
    // "structure" listed next to a failure would let a caller that only reads
    // `checks` believe the file was structurally sound.
    expect(result.checks).not.toContain("structure");
  });

  it("rejects another manifest version", () => {
    const result = verifyManifest(manifest({ version: 99 }));
    expect(result.ok).toBe(false);
    expect(result.mismatches[0]).toMatchObject({ path: "version", expected: "1", actual: "99" });
  });

  it("rejects an acceptance verdict outside pass|fail", () => {
    const bad = manifest({
      acceptance: [{ item: {}, verdict: "maybe" as never, undetermined: false }],
    });
    const result = verifyManifest(bad);
    expect(result.ok).toBe(false);
    expect(result.mismatches.map((entry) => entry.path)).toContain("acceptance[0].verdict");
  });

  it("rejects a document that is not an object", () => {
    const result = verifyManifest("nope");
    expect(result.ok).toBe(false);
    expect(result.mismatches[0].path).toBe("manifest");
  });
});
