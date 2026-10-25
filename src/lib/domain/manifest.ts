import { canonicalJson, sha256 } from "@/lib/ids";

/**
 * A run manifest is the part of a run that has to survive the database.
 *
 * The audit chain already answers "what did the system do"; a manifest answers
 * "what exactly did THIS run produce, and can you check it without us". So it
 * carries hashes, not prompts: a manifest that embeds the model prompt leaks
 * the workspace, and one that can only be checked against our database is not
 * evidence for anyone else.
 */
export const MANIFEST_VERSION = 1;

export type ManifestStep = {
  idx: number;
  type: string;
  tool: string | null;
  /**
   * `sha256(canonicalJson(input))`, hashed rather than embedded: step input
   * carries the user's prompt text and the workspace, and a manifest that leaks
   * those is not shareable.
   */
  inputHash: string;
  /** `sha256(canonicalJson(output))` of the stored step. */
  outputHash: string;
};

export type ManifestArtifact = { id: string; sha256: string };
export type ManifestEvidence = { id: string; contentHash: string };
export type ManifestAcceptance = {
  item: Record<string, unknown>;
  verdict: "pass" | "fail";
  undetermined: boolean;
};
export type ManifestApproval = {
  id: string;
  action: string;
  status: string;
  decidedAt: string | null;
};

export type RunManifest = {
  version: number;
  runId: string;
  taskId: string;
  agentId: string;
  userId: string;
  status: string;
  createdAt: string;
  model: { provider: string | null; model: string | null };
  /** Bumped by hand when the prompt template changes (see llm.ts). */
  promptVersion: number;
  steps: ManifestStep[];
  artifacts: ManifestArtifact[];
  evidence: ManifestEvidence[];
  /** Verdicts from the latest audit, plus the run they were read from. */
  acceptance: ManifestAcceptance[];
  acceptanceRunId: string | null;
  approvals: ManifestApproval[];
  /**
   * Head of the user's audit chain when the manifest was built. Null when the
   * user has no audit event yet — an absent anchor must stay absent rather than
   * be faked as `seq: 0`, which a verifier would have to distrust anyway.
   */
  auditHead: { seq: number; hash: string } | null;
  merkleRoot: string | null;
};

const HEX64 = /^[0-9a-f]{64}$/;

/** One leaf per step. Canonical JSON so a re-ordering key cannot change it. */
export function leafHash(step: {
  idx: number;
  type: string;
  tool: string | null;
  inputHash: string;
  outputHash: string;
}): string {
  return sha256(canonicalJson(step));
}

/**
 * Merkle root with the rules pinned down, because a verifier that disagrees
 * with the builder is a verifier that always says "tampered".
 *
 * `n=0` has no root. `n=1` is the leaf itself (so a one-step run is verifiable
 * without inventing a duplicate). Above that, pairs are hashed in sorted order
 * and an odd tail is promoted unchanged rather than duplicated — duplication
 * would make `[a]` and `[a,a]` indistinguishable.
 */
export function merkleRoot(leaves: string[]): string | null {
  if (leaves.length === 0) return null;
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      const first = level[i];
      const second = level[i + 1];
      next.push(sha256(first < second ? first + second : second + first));
    }
    if (level.length % 2 === 1) next.push(level[level.length - 1]);
    level = next;
  }
  return level[0];
}

export type ManifestMismatch = {
  path: string;
  expected: string;
  actual: string;
};

export type VerifyOptions = {
  /**
   * The user audit chain, in `seq` order. Offline callers usually pass only the
   * tail; without it the anchor is reported as unchecked, never as verified.
   */
  chain?: { seq: number; hash: string }[];
};

export type VerifyResult = {
  ok: boolean;
  checks: string[];
  unchecked: string[];
  mismatches: ManifestMismatch[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Check a manifest without trusting the system that produced it.
 *
 * What it can prove offline: the file is structurally sound, every hash has the
 * right shape, and the steps recompute to the stored Merkle root. What it
 * cannot prove offline is that the audit head exists — that needs the chain, so
 * an unsupplied chain is listed in `unchecked` instead of being called a pass.
 */
export function verifyManifest(
  manifest: unknown,
  options: VerifyOptions = {},
): VerifyResult {
  const checks: string[] = [];
  const unchecked: string[] = [];
  const mismatches: ManifestMismatch[] = [];
  const fail = (path: string, expected: unknown, actual: unknown) => {
    mismatches.push({
      path,
      expected: String(expected),
      actual: String(actual),
    });
  };

  const doc = asRecord(manifest);
  if (!doc) {
    fail("manifest", "object", typeof manifest);
    return { ok: false, checks, unchecked, mismatches };
  }

  if (doc.version !== MANIFEST_VERSION) {
    fail("version", MANIFEST_VERSION, doc.version);
  }
  for (const key of ["runId", "taskId", "agentId", "userId"] as const) {
    if (typeof doc[key] !== "string" || doc[key] === "") {
      fail(key, "non-empty string", doc[key]);
    }
  }

  const steps = Array.isArray(doc.steps) ? doc.steps : null;
  if (!steps) {
    fail("steps", "array", typeof doc.steps);
    return { ok: false, checks, unchecked, mismatches };
  }

  const parsed: {
    idx: number;
    type: string;
    tool: string | null;
    inputHash: string;
    outputHash: string;
  }[] = [];
  steps.forEach((raw, index) => {
    const step = asRecord(raw);
    if (!step) {
      fail("steps[" + index + "]", "object", typeof raw);
      return;
    }
    for (const key of ["inputHash", "outputHash"] as const) {
      const hash = step[key];
      if (typeof hash !== "string" || !HEX64.test(hash)) {
        fail("steps[" + index + "]." + key, "64 hex chars", hash);
      }
    }
    parsed.push({
      idx: typeof step.idx === "number" ? step.idx : -1,
      type: typeof step.type === "string" ? step.type : "",
      tool: typeof step.tool === "string" ? step.tool : null,
      inputHash: typeof step.inputHash === "string" ? step.inputHash : "",
      outputHash: typeof step.outputHash === "string" ? step.outputHash : "",
    });
  });

  for (const [field, key] of [
    ["artifacts", "sha256"],
    ["evidence", "contentHash"],
  ] as const) {
    const list = doc[field];
    if (list !== undefined && !Array.isArray(list)) {
      fail(field, "array", typeof list);
      continue;
    }
    (list ?? []).forEach((raw, index) => {
      const entry = asRecord(raw);
      const hash = entry?.[key];
      if (typeof hash !== "string" || !HEX64.test(hash)) {
        fail(field + "[" + index + "]." + key, "64 hex chars", hash);
      }
    });
  }

  if (Array.isArray(doc.acceptance)) {
    doc.acceptance.forEach((raw, index) => {
      const entry = asRecord(raw);
      const verdict = entry?.verdict;
      if (verdict !== "pass" && verdict !== "fail") {
        fail("acceptance[" + index + "].verdict", "pass|fail", verdict);
      }
    });
  }

  // A malformed field is a structural failure, so the label must not appear: a
  // caller that reads only `checks` would otherwise see a broken file as sound.
  if (mismatches.length === 0) checks.push("structure");

  const recomputed = merkleRoot(parsed.map((step) => leafHash(step)));
  if (recomputed !== doc.merkleRoot) {
    fail("merkleRoot", recomputed, doc.merkleRoot);
  } else {
    checks.push("merkle");
  }

  if (doc.auditHead === null) {
    unchecked.push("auditHead");
    return {
      ok: mismatches.length === 0,
      checks,
      unchecked,
      mismatches,
    };
  }

  const head = asRecord(doc.auditHead);
  const seq = head?.seq;
  const hash = head?.hash;
  if (typeof seq !== "number" || typeof hash !== "string" || !HEX64.test(hash)) {
    fail("auditHead", "seq + 64 hex hash", JSON.stringify(head));
  } else if (!options.chain) {
    unchecked.push("auditHead");
  } else if (!options.chain.some((row) => row.seq === seq && row.hash === hash)) {
    fail("auditHead", seq + ":" + hash, "not in the supplied chain");
  } else {
    checks.push("auditHead");
  }

  return {
    ok: mismatches.length === 0,
    checks,
    unchecked,
    mismatches,
  };
}
