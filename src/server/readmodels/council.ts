import { councilPageSchema, type CouncilPageDto } from "@/contracts";
import { asDto } from "@/server/dto-guard";
import { toAgentDto, toCouncilDto, toCouncilPositionDto } from "@/server/mappers";
import { getCouncilData } from "@/server/services/queries/council";

export async function loadCouncil(
  userId: string,
): Promise<CouncilPageDto | null> {
  const data = await getCouncilData(userId);
  if (!data) return null;

  return asDto(
    councilPageSchema,
    {
      council: toCouncilDto(data.council),
      positions: data.positions.map(toCouncilPositionDto),
      agents: data.agents.map(toAgentDto),
    },
    "CouncilPage",
  );
}
