import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { agentCardSchema, type AgentCardDto } from "@/contracts";
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { asDto } from "@/server/dto-guard";
import { getAgentData } from "@/server/services/queries/agent";

/**
 * Portable Agent Card. Deliberately whitelists fields: no email, no memories,
 * no health data, no raw task descriptions.
 */
export async function loadAgentCard(
  userId: string,
  agentId: string,
): Promise<AgentCardDto | null> {
  const data = await getAgentData(agentId, userId);
  if (!data) return null;

  // A separate read: `data.tasks` is the detail page's window (eight newest by
  // update time), so an Agent whose latest work is still in flight used to
  // export an empty outcomes list while holding plenty of accepted work.
  const accepted = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.assigneeId, agentId),
        eq(tasks.userId, userId),
        inArray(tasks.status, ["accepted", "done"]),
      ),
    )
    .orderBy(sql`${tasks.acceptedAt} desc nulls last`, desc(tasks.id))
    .limit(5);
  const outcomes = accepted
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      status: task.status,
      acceptedAt: task.acceptedAt ? task.acceptedAt.toISOString() : null,
    }));

  return asDto(
    agentCardSchema,
    {
      schemaVersion: "1.0",
      id: data.agent.id,
      name: data.agent.name,
      role: data.agent.role,
      title: data.agent.title,
      charter: data.agent.charter,
      objective: data.agent.objective,
      status: data.agent.status,
      lifecycleStage: data.agent.lifecycleStage,
      autonomyLevel: data.agent.autonomyLevel,
      trustScore: data.agent.trustScore,
      successCount: data.agent.successCount,
      failCount: data.agent.failCount,
      tools: data.agent.tools,
      skills: data.skills.map((skill) => ({
        name: skill.name,
        version: skill.version,
        label: skill.label,
        status: skill.status,
        successCount: skill.successCount,
        failCount: skill.failCount,
      })),
      outcomes,
      generatedAt: new Date().toISOString(),
    },
    "AgentCard",
  );
}
