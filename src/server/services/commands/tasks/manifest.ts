import { and, asc, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  approvals,
  artifacts,
  auditEvents,
  evidence,
  runs,
  steps,
  tasks,
} from "@/lib/db/schema";
import {
  MANIFEST_VERSION,
  leafHash,
  merkleRoot,
  type ManifestAcceptance,
  type RunManifest,
} from "@/lib/domain/manifest";
import { canonicalJson, sha256 } from "@/lib/ids";
import { PROMPT_TEMPLATE_VERSION } from "@/lib/llm";

function hashValue(value: unknown): string {
  return sha256(canonicalJson(value ?? null));
}

function readChecklist(output: unknown): ManifestAcceptance[] {
  if (typeof output !== "object" || output === null) return [];
  const checklist = (output as { checklist?: unknown }).checklist;
  if (!Array.isArray(checklist)) return [];
  const report: ManifestAcceptance[] = [];
  for (const entry of checklist) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as {
      item?: unknown;
      passed?: unknown;
      undetermined?: unknown;
    };
    const item =
      typeof row.item === "object" && row.item !== null
        ? (row.item as Record<string, unknown>)
        : {};
    report.push({
      item,
      verdict: row.passed === true ? "pass" : "fail",
      undetermined: row.undetermined === true,
    });
  }
  return report;
}

/**
 * Build the manifest for one run, or null when the run is not this user's.
 *
 * Everything here is read back from storage, never from the executor's
 * in-memory state: a manifest assembled from what the run *meant* to do proves
 * nothing, while one assembled from the rows an attacker could have rewritten
 * proves exactly the right thing — that rewriting them changes the hashes.
 */
export async function buildManifest(
  runId: string,
  userId: string,
): Promise<RunManifest | null> {
  // Ownership is part of the lookup, so a foreign run is never read at all.
  const [row] = await db
    .select({ run: runs })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(eq(runs.id, runId), eq(tasks.userId, userId)));
  if (!row) return null;

  const run = row.run;

  const [stepRows, artifactRows, evidenceRows, approvalRows, headRows, auditRows] =
    await Promise.all([
      db
        .select()
        .from(steps)
        .where(eq(steps.runId, runId))
        .orderBy(asc(steps.idx)),
      db
        .select({ id: artifacts.id, content: artifacts.content })
        .from(artifacts)
        .where(eq(artifacts.runId, runId))
        .orderBy(asc(artifacts.createdAt)),
      db
        .select({ id: evidence.id, contentHash: evidence.contentHash })
        .from(evidence)
        .where(eq(evidence.runId, runId))
        .orderBy(asc(evidence.createdAt)),
      db
        .select()
        .from(approvals)
        .where(eq(approvals.taskId, run.taskId))
        .orderBy(asc(approvals.createdAt)),
      db
        .select({ seq: auditEvents.seq, hash: auditEvents.hash })
        .from(auditEvents)
        .where(eq(auditEvents.userId, userId))
        .orderBy(desc(auditEvents.seq))
        .limit(1),
      // Verdicts live in the newest audit step of the task, not in the run
      // being exported: an audit is its own run.
      db
        .select({ runId: steps.runId, output: steps.output })
        .from(steps)
        .innerJoin(runs, eq(runs.id, steps.runId))
        .where(and(eq(runs.taskId, run.taskId), eq(steps.type, "audit")))
        .orderBy(desc(steps.createdAt))
        .limit(1),
    ]);

  const manifestSteps = stepRows.map((step) => ({
    idx: step.idx,
    type: step.type,
    tool: step.tool,
    inputHash: hashValue(step.input),
    outputHash: hashValue(step.output),
  }));

  const auditRow = auditRows[0];

  return {
    version: MANIFEST_VERSION,
    runId: run.id,
    taskId: run.taskId,
    agentId: run.agentId,
    userId,
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    model: { provider: run.provider, model: run.model },
    promptVersion: PROMPT_TEMPLATE_VERSION,
    steps: manifestSteps,
    artifacts: artifactRows.map((artifact) => ({
      id: artifact.id,
      sha256: sha256(artifact.content),
    })),
    evidence: evidenceRows.map((item) => ({
      id: item.id,
      contentHash: item.contentHash,
    })),
    acceptance: readChecklist(auditRow?.output),
    acceptanceRunId: auditRow?.runId ?? null,
    approvals: approvalRows.map((approval) => ({
      id: approval.id,
      action: approval.action,
      status: approval.status,
      decidedAt: approval.decidedAt ? approval.decidedAt.toISOString() : null,
    })),
    auditHead: headRows[0] ? { seq: Number(headRows[0].seq), hash: headRows[0].hash } : null,
    merkleRoot: merkleRoot(manifestSteps.map((step) => leafHash(step))),
  };
}
