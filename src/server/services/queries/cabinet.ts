import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, tasks } from "@/lib/db/schema";
import { getWorkspace } from "./workspace";
export async function getCabinetData(userId: string) {
  const [workspace, allAgents, allTasks] = await Promise.all([
    getWorkspace(userId),
    db
      .select()
      .from(agents)
      .where(eq(agents.userId, userId))
      .orderBy(asc(agents.createdAt)),
    db.select().from(tasks).where(eq(tasks.userId, userId)),
  ]);
  return {
    user: workspace.user,
    profile: workspace.profile,
    agents: allAgents,
    tasks: allTasks,
  };
}
