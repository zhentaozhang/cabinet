import { memoryPageSchema, type MemoryPageDto } from "@/contracts";
import { asDto } from "@/server/dto-guard";
import { toMemoryDto } from "@/server/mappers";
import {
  getMemoryData,
  type MemoryView,
} from "@/server/services/engine";

export async function loadMemory(
  userId: string,
  type?: string,
  view: MemoryView = "current",
): Promise<MemoryPageDto> {
  const data = await getMemoryData(userId, type, view);

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
