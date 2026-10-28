import { asc, count, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  dissents,
  insights,
  memories,
  skills,
  tasks,
} from "@/lib/db/schema";
import { getPolicyConfigFor } from "@/lib/policy/config";
import { loadWeeklyUsage } from "./budget";
import { getWorkspace } from "./workspace";

/** Read a group-by result into a status → count map, ignoring foreign keys. */
function tally(
  rows: Array<{ status: string; n: number }>,
  keys: string[],
): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(
    keys.map((key) => [key, 0]),
  );
  for (const row of rows) {
    if (row.status in out) out[row.status] = Number(row.n);
  }
  return out;
}

export async function getCabinetData(userId: string) {
  const [workspace, allAgents, allTasks, policy] = await Promise.all([
    getWorkspace(userId),
    db
      .select()
      .from(agents)
      .where(eq(agents.userId, userId))
      .orderBy(asc(agents.createdAt)),
    db.select().from(tasks).where(eq(tasks.userId, userId)),
    // 用户级策略：制度那一栏写的是「连续驳回几次会暂停 Agent」，而那个
    // 数字是洞察可调的键（audit.rejectStreakLimit），页面上写死一个常量，
    // 用户在复盘页把上限调到 5 之后，这里还在承诺 2。
    getPolicyConfigFor(userId),
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

  /**
   * Four group-by counts rather than loading the tables: the cabinet only needs
   * "how much has this org learned". Skills hang off agents, not the user, so
   * that one joins; the rest filter directly.
   */
  const [skillRows, memoryRows, insightRows, dissentRows] = await Promise.all([
    db
      .select({ status: skills.status, n: count() })
      .from(skills)
      .innerJoin(agents, eq(skills.agentId, agents.id))
      .where(eq(agents.userId, userId))
      .groupBy(skills.status),
    db
      .select({ status: memories.status, n: count() })
      .from(memories)
      .where(eq(memories.userId, userId))
      .groupBy(memories.status),
    db
      .select({ status: insights.status, n: count() })
      .from(insights)
      .where(eq(insights.userId, userId))
      .groupBy(insights.status),
    db
      .select({ status: dissents.status, n: count() })
      .from(dissents)
      .where(eq(dissents.userId, userId))
      .groupBy(dissents.status),
  ]);

  const skillTally = tally(skillRows, ["active"]);
  const memoryTally = tally(memoryRows, ["active", "conflicted"]);
  const insightTally = tally(insightRows, ["applied", "proposed"]);
  const dissentTally = tally(dissentRows, ["pending", "vindicated"]);

  return {
    user: workspace.user,
    profile: workspace.profile,
    agents: allAgents,
    tasks: allTasks,
    budgets: Object.fromEntries(budgets),
    policy: { rejectStreakLimit: policy.audit.rejectStreakLimit },
    knowledge: {
      skills: {
        total: skillRows.reduce((sum, row) => sum + Number(row.n), 0),
        certified: skillTally.active ?? 0,
      },
      memories: {
        active: memoryTally.active ?? 0,
        conflicted: memoryTally.conflicted ?? 0,
      },
      insights: {
        applied: insightTally.applied ?? 0,
        proposed: insightTally.proposed ?? 0,
      },
      dissents: {
        total: dissentRows.reduce((sum, row) => sum + Number(row.n), 0),
        vindicated: dissentTally.vindicated ?? 0,
        pending: dissentTally.pending ?? 0,
      },
    },
  };
}
