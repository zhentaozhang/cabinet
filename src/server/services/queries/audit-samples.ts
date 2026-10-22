import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, artifacts, auditEvents, runs, tasks } from "@/lib/db/schema";
import {
  isEligibleAuditSample,
  type AuditSampleInput,
} from "@/lib/domain/provenance";
import type { Tx } from "../shared/tx";

/**
 * One audit verdict, reduced to the provenance facts that decide whether it
 * counts as evidence of real model execution.
 */
export type AuditSample = {
  taskId: string;
  action: string;
  seq: number;
  eligible: boolean;
};

export type AgentAuditWindow = {
  /** Newest-first, one entry per distinct task, capped at the window size. */
  samples: AuditSample[];
  eligibleSamples: AuditSample[];
  passRate: number;
};

const MAX_SAMPLE_ROWS = 500;

/**
 * Load the audit window for every Agent of a user.
 *
 * Deliberately one query for the whole workspace: the Review page and the
 * promotion command must read the same evidence, and reading it twice through
 * different code paths is how the two views drifted apart before.
 *
 * Dedupe is by task, keeping the newest verdict, so retrying one task can never
 * inflate the sample count.
 */
export async function loadAuditWindows(
  userId: string,
  window: number,
  tx?: Tx,
): Promise<Map<string, AgentAuditWindow>> {
  const client = tx ?? db;
  const userAgents = await client
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.userId, userId));
  const windows = new Map<string, AgentAuditWindow>();
  for (const agent of userAgents) {
    windows.set(agent.id, { samples: [], eligibleSamples: [], passRate: 0 });
  }
  if (userAgents.length === 0) return windows;

  const rows = await client
    .select({
      seq: auditEvents.seq,
      action: auditEvents.action,
      taskId: tasks.id,
      assigneeId: tasks.assigneeId,
      artifactSubmittedBy: artifacts.submittedBy,
      artifactSourceType: artifacts.sourceType,
      executionChannel: runs.mode,
      providerAttemptId: runs.providerAttemptId,
    })
    .from(auditEvents)
    .innerJoin(tasks, eq(tasks.id, auditEvents.target))
    .innerJoin(artifacts, eq(artifacts.taskId, tasks.id))
    .innerJoin(
      runs,
      and(eq(runs.taskId, tasks.id), eq(runs.agentId, tasks.assigneeId)),
    )
    .where(
      and(
        eq(auditEvents.userId, userId),
        inArray(auditEvents.action, ["audit.accept", "audit.reject"]),
        inArray(
          tasks.assigneeId,
          userAgents.map((agent) => agent.id),
        ),
      ),
    )
    // Newest verdict first, and within one verdict the newest artifact and the
    // newest run of the assignee: the first row per task is the pair the
    // auditor actually judged.
    .orderBy(
      desc(auditEvents.seq),
      desc(artifacts.createdAt),
      desc(runs.createdAt),
    )
    .limit(MAX_SAMPLE_ROWS);

  const seenTasks = new Set<string>();
  for (const row of rows) {
    if (!row.assigneeId || !row.taskId) continue;
    const dedupeKey = `${row.assigneeId}:${row.taskId}`;
    if (seenTasks.has(dedupeKey)) continue;
    seenTasks.add(dedupeKey);

    const windowForAgent = windows.get(row.assigneeId);
    if (!windowForAgent) continue;
    if (windowForAgent.samples.length >= window) continue;

    const input: AuditSampleInput = {
      artifactSubmittedBy: row.artifactSubmittedBy,
      artifactSourceType: row.artifactSourceType,
      executionChannel: row.executionChannel,
      hasProviderAttempt: row.providerAttemptId !== null,
    };
    const sample: AuditSample = {
      taskId: row.taskId,
      action: row.action,
      seq: row.seq,
      eligible: isEligibleAuditSample(input),
    };
    windowForAgent.samples.push(sample);
    if (sample.eligible) windowForAgent.eligibleSamples.push(sample);
  }

  for (const windowForAgent of windows.values()) {
    const eligible = windowForAgent.eligibleSamples;
    const accepts = eligible.filter((s) => s.action === "audit.accept").length;
    windowForAgent.passRate = eligible.length > 0 ? accepts / eligible.length : 0;
  }
  return windows;
}

export async function loadAuditWindow(
  agentId: string,
  userId: string,
  window: number,
  tx?: Tx,
): Promise<AgentAuditWindow> {
  const all = await loadAuditWindows(userId, window, tx);
  const [row] = await (tx ?? db)
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)));
  if (!row) return { samples: [], eligibleSamples: [], passRate: 0 };
  return all.get(agentId) ?? { samples: [], eligibleSamples: [], passRate: 0 };
}
