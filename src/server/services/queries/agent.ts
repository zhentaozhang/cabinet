import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, memories, runs, skills, tasks, users } from "@/lib/db/schema";
export async function getAgentData(agentId: string, userId: string) {
  // Ownership is part of the WHERE clause, not a post-fetch check.
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)));
  if (!agent) return null;

  const [agentRuns, agentMemories, agentSkills, assigned, userRows] =
    await Promise.all([
    db
      .select()
      .from(runs)
      .where(eq(runs.agentId, agentId))
      .orderBy(desc(runs.createdAt))
      .limit(10),
    db
      .select()
      .from(memories)
      .where(and(eq(memories.agentId, agentId), eq(memories.userId, userId)))
      .orderBy(desc(memories.salience))
      .limit(8),
    db.select().from(skills).where(eq(skills.agentId, agentId)),
    db
      .select()
      .from(tasks)
      .where(and(eq(tasks.assigneeId, agentId), eq(tasks.userId, userId)))
      .orderBy(desc(tasks.updatedAt))
      .limit(8),
    db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId)),
  ]);
  return {
    timezone: userRows[0]?.timezone ?? "UTC",
    agent,
    runs: agentRuns,
    memories: agentMemories,
    skills: agentSkills,
    tasks: assigned,
  };
}
