import { agentPageSchema, type AgentPageDto } from "@/contracts";
import { asDto } from "@/server/dto-guard";
import {
  toAgentDto,
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
      agent: toAgentDto(data.agent),
      runs: data.runs.map(toRunDto),
      memories: data.memories.map(toMemoryDto),
      skills: data.skills.map(toSkillDto),
      tasks: data.tasks.map(toTaskDto),
    },
    "AgentPage",
  );
}
