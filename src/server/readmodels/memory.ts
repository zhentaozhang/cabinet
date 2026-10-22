import { memoryPageSchema, type MemoryPageDto } from "@/contracts";
import { asDto } from "@/server/dto-guard";
import { toMemoryDto } from "@/server/mappers";
import { getMemoryData } from "@/server/services/engine";

export async function loadMemory(
  userId: string,
  type?: string,
): Promise<MemoryPageDto> {
  const data = await getMemoryData(userId, type);

  return asDto(
    memoryPageSchema,
    {
      memories: data.memories.map(toMemoryDto),
      counts: data.counts,
      stale: data.stale,
    },
    "MemoryPage",
  );
}
