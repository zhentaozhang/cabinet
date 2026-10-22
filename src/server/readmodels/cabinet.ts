import { cabinetPageSchema, type CabinetPageDto } from "@/contracts";
import { asDto } from "@/server/dto-guard";
import {
  toAgentDto,
  toBudgetViewDto,
  toProfileDto,
  toTaskDto,
  toUserDto,
} from "@/server/mappers";
import { getCabinetData } from "@/server/services/queries/cabinet";

export async function loadCabinet(userId: string): Promise<CabinetPageDto> {
  const data = await getCabinetData(userId);

  return asDto(
    cabinetPageSchema,
    {
      user: toUserDto(data.user),
      profile: data.profile ? toProfileDto(data.profile) : null,
      agents: data.agents.map(toAgentDto),
      tasks: data.tasks.map(toTaskDto),
      budgets: Object.fromEntries(
        Object.entries(data.budgets).map(([agentId, usage]) => [
          agentId,
          toBudgetViewDto(usage),
        ]),
      ),
    },
    "CabinetPage",
  );
}
