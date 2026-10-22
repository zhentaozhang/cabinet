import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, tasks } from "@/lib/db/schema";
import { loadWeeklyUsage } from "../commands/tasks/execution";
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
  const timezone = workspace.user.timezone ?? "UTC";
  // Read-only ledger views, one per card, so the grid never provisions buckets.
  const budgets = await Promise.all(
    allAgents.map(async (agent) => [
      agent.id,
      await loadWeeklyUsage(agent.id, timezone, new Date(), undefined, {
        provision: false,
      }),
    ] as const),
  );

  return {
    user: workspace.user,
    profile: workspace.profile,
    agents: allAgents,
    tasks: allTasks,
    budgets: Object.fromEntries(budgets),
  };
}
