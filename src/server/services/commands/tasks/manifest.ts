import { and, asc, desc, eq, isNull, or } from "drizzle-orm";

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
  manifestDigest,
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
    // An audit row can say "nobody decided this" (AGENTS.md 第 2 条). That is a
    // third verdict, not a failure: recording it as "fail" tells a reader the
    // work was judged and rejected (5f332e7f 建议 10).
    const undetermined = row.undetermined === true;
    report.push({
      item,
      verdict: undetermined ? "undetermined" : row.passed === true ? "pass" : "fail",
      undetermined,
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
      // Only approvals that belong to this run are listed, plus the task-scoped
      // ones that no run has spent yet (`run_id` stays null until a run
      // consumes the approval). Without the filter a manifest for run A happily
      // renders a decision taken for run B, and nothing in the document says so.
      // Ownership is "the run that spent it", not "the run that asked for it":
      // an approval requested by run A can be consumed by run B.
      db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.taskId, run.taskId),
            or(isNull(approvals.runId), eq(approvals.runId, run.id)),
          ),
        )
        // Two approvals can share a timestamp (now() is transaction time), so
        // the id breaks the tie and the same run exports the same bytes twice.
        .orderBy(asc(approvals.createdAt), asc(approvals.id)),
      db
        .select({ seq: auditEvents.seq, hash: auditEvents.hash })
        .from(auditEvents)
        .where(eq(auditEvents.userId, userId))
        .orderBy(desc(auditEvents.seq))
        .limit(1),
      // Verdicts live in the newest audit step of the task, not in the run
      // being exported: an audit is its own run. "Newest" is by timestamp and
      // then by id, because every row of one transaction shares its now() and
      // an untied ORDER BY would let the same run export two different
      // digests.
      db
        .select({ runId: steps.runId, output: steps.output })
        .from(steps)
        .innerJoin(runs, eq(runs.id, steps.runId))
        .where(and(eq(runs.taskId, run.taskId), eq(steps.type, "audit")))
        .orderBy(desc(steps.createdAt), desc(steps.id))
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

  const body = {
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
  return {
    ...body,
    digest: manifestDigest(body as Record<string, unknown>),
  } as RunManifest;
}