import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { approvals, runs } from "@/lib/db/schema";

export async function loadSpentCents(agentId: string, periodStart: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${runs.costCents}), 0)` })
    .from(runs)
    .where(and(eq(runs.agentId, agentId), gte(runs.createdAt, periodStart)));
  return Number(row?.total ?? 0);
}

export async function loadLatestApproval(taskId: string) {
  const [row] = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.taskId, taskId),
        inArray(approvals.status, ["pending", "approved"]),
      ),
    )
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  return row ?? null;
}
