import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, tasks } from "@/lib/db/schema";
import { getWorkspace } from "./workspace";
export async function getCabinetData(userId: string) {
  const { user, profile } = await getWorkspace(userId);
  const allAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, userId))
    .orderBy(asc(agents.createdAt));
  const openTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.userId, userId));
  return { user, profile, agents: allAgents, tasks: openTasks };
}
