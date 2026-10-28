import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentGrants,
  agents,
  memories,
  runs,
  skills,
  tasks,
  users,
} from "@/lib/db/schema";
import { getPolicyConfigFor } from "@/lib/policy/config";
import { loadWeeklyUsage } from "./budget";
import { loadApprenticeshipEvidence } from "./apprenticeship";
export async function getAgentData(agentId: string, userId: string) {
  // Ownership is part of the WHERE clause, not a post-fetch check.
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)));
  if (!agent) return null;

  const [
    agentRuns,
    agentMemories,
    memoryTotal,
    agentSkills,
    assigned,
    taskTotal,
    userRows,
    grantRows,
    policy,
  ] = await Promise.all([
    // Every list here is a window, so the tie-break column matters: rows created
    // in one statement share a timestamp, and without an id the "latest run"
    // and the memory card would reshuffle between two identical requests.
    db
      .select()
      .from(runs)
      .where(eq(runs.agentId, agentId))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(10),
    db
      .select()
      .from(memories)
      .where(and(eq(memories.agentId, agentId), eq(memories.userId, userId)))
      .orderBy(desc(memories.salience), desc(memories.createdAt), desc(memories.id))
      .limit(8),
    // The card shows five of them and the header links to the rest, so it needs
    // the real size of the set rather than the length of this window.
    db
      .select({ total: count() })
      .from(memories)
      .where(and(eq(memories.agentId, agentId), eq(memories.userId, userId))),
    db.select().from(skills).where(eq(skills.agentId, agentId)),
    db
      .select()
      .from(tasks)
      .where(and(eq(tasks.assigneeId, agentId), eq(tasks.userId, userId)))
      .orderBy(desc(tasks.updatedAt), desc(tasks.id))
      .limit(8),
    // The Performance tile says "Tasks", next to lifetime pass/reject counts, so
    // it must be every task this Agent carried — not the eight-row list below.
    db
      .select({ total: count() })
      .from(tasks)
      .where(and(eq(tasks.assigneeId, agentId), eq(tasks.userId, userId))),
    db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId)),
    // Standing policies first: they are what the user can revoke here.
    db
      .select()
      .from(agentGrants)
      .where(eq(agentGrants.agentId, agentId))
      .orderBy(desc(agentGrants.createdAt), desc(agentGrants.id)),
    // 升级门槛：卡片上那行「升级需要」必须印后端真正判的那几条，
    // 包括审计通过率下限（decideUpgrade 最后一道闸）。读用户级配置，
    // 因为它给的是这台部署对这个用户生效的门槛，而不是另一份常量副本。
    getPolicyConfigFor(userId),
  ]);
  const timezone = userRows[0]?.timezone ?? "UTC";
  // Read-only: a page load never provisions a bucket.
  const budget = await loadWeeklyUsage(agentId, timezone, new Date(), undefined, {
    provision: false,
  });
  // Only the apprentice has training evidence; every other page skips the query.
  const apprenticeship =
    agent.role === "apprentice"
      ? await loadApprenticeshipEvidence(userId)
      : null;

  return {
    apprenticeship,
    timezone,
    policy: {
      autonomy: {
        minTrust: policy.autonomy.minTrust,
        minSuccesses: policy.autonomy.minSuccesses,
        minAuditSamples: policy.autonomy.minAuditSamples,
        minAuditPassRate: policy.autonomy.minAuditPassRate,
      },
    },
    agent,
    budget,
    grants: grantRows,
    runs: agentRuns,
    memories: agentMemories,
    memoryTotal: Number(memoryTotal[0]?.total ?? 0),
    skills: agentSkills,
    taskTotal: Number(taskTotal[0]?.total ?? 0),
    tasks: assigned,
  };
}
