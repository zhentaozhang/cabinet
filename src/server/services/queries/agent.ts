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
import { loadWeeklyUsage } from "./budget";
import { loadApprenticeshipEvidence } from "./apprenticeship";
export async function getAgentData(agentId: string, userId: string) {
  // Ownership is part of the WHERE clause, not a post-fetch check.
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)));
  if (!agent) return null;

  const [agentRuns, agentMemories, memoryTotal, agentSkills, assigned, userRows, grantRows] =
    await Promise.all([
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
    agent,
    budget,
    grants: grantRows,
    runs: agentRuns,
    memories: agentMemories,
    memoryTotal: Number(memoryTotal[0]?.total ?? 0),
    skills: agentSkills,
    tasks: assigned,
  };
}
