import { handleQuery } from "@/lib/api/read";
import { loadMemory } from "@/server/readmodels";

export async function GET(request: Request) {
  const type = new URL(request.url).searchParams.get("type") ?? undefined;
  return handleQuery((userId) => loadMemory(userId, type));
}
