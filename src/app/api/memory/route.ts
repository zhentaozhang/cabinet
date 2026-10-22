import { handleQuery } from "@/lib/api/read";
import { loadMemory } from "@/server/readmodels";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const type = params.get("type") ?? undefined;
  const view = params.get("view") === "history" ? "history" : "current";
  return handleQuery((userId) => loadMemory(userId, type, view));
}
