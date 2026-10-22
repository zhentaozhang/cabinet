import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, memories, runs, skills, tasks } from "@/lib/db/schema";
export async function getAgentData(agentId: string, userId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.userId !== userId) return null;
  const agentRuns = await db
    .select()
    .from(runs)
    .where(eq(runs.agentId, agentId))
    .orderBy(desc(runs.createdAt))
    .limit(10);
  const agentMemories = await db
    .select()
    .from(memories)
    .where(eq(memories.agentId, agentId))
    .orderBy(desc(memories.salience))
    .limit(8);
  const agentSkills = await db
    .select()
    .from(skills)
    .where(eq(skills.agentId, agentId));
  const assigned = await db
    .select()
    .from(tasks)
    .where(eq(tasks.assigneeId, agentId))
    .orderBy(desc(tasks.updatedAt))
    .limit(8);
  return {
    agent,
    runs: agentRuns,
    memories: agentMemories,
    skills: agentSkills,
    tasks: assigned,
  };
}
