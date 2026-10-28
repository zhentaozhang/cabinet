import { memoryPageSchema, type MemoryPageDto } from "@/contracts";
import { asDto } from "@/server/dto-guard";
import { toMemoryDto } from "@/server/mappers";
import {
  getMemoryData,
  type MemoryView,
} from "@/server/services/queries/memory";

export async function loadMemory(
  userId: string,
  type?: string,
  view: MemoryView = "current",
  options: { limit?: number; offset?: number } = {},
): Promise<MemoryPageDto> {
  const data = await getMemoryData(userId, type, view, options);

  return asDto(
    memoryPageSchema,
    {
      timezone: data.timezone,
      memories: data.memories.map(toMemoryDto),
      counts: data.counts,
      stale: data.stale,
      conflicts: data.conflicts,
      avgConfidence: data.avgConfidence,
      total: data.total,
      offset: data.offset,
      limit: data.limit,
      hasMore: data.hasMore,
    },
    "MemoryPage",
  );
}
