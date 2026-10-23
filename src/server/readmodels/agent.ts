import { agentPageSchema, type AgentPageDto } from "@/contracts";
import { asDto } from "@/server/dto-guard";
import {
  toAgentDto,
  toBudgetViewDto,
  toGrantDto,
  toMemoryDto,
  toRunDto,
  toSkillDto,
  toTaskDto,
} from "@/server/mappers";
import { getAgentData } from "@/server/services/queries/agent";

export async function loadAgent(
  agentId: string,
  userId: string,
): Promise<AgentPageDto | null> {
  const data = await getAgentData(agentId, userId);
  if (!data) return null;

  return asDto(
    agentPageSchema,
    {
      timezone: data.timezone,
      agent: toAgentDto(data.agent),
      budget: toBudgetViewDto(data.budget),
      grants: data.grants.map((grant) => toGrantDto(grant)),
      apprenticeship: data.apprenticeship
        ? {
            ...data.apprenticeship,
            candidates: data.apprenticeship.candidates.map((candidate) => ({
              ...candidate,
              endedAt: candidate.endedAt ? candidate.endedAt.toISOString() : null,
            })),
          }
        : null,
      runs: data.runs.map(toRunDto),
      memories: data.memories.map(toMemoryDto),
      skills: data.skills.map(toSkillDto),
      tasks: data.tasks.map(toTaskDto),
    },
    "AgentPage",
  );
}
