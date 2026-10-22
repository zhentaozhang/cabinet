import { handleQuery } from "@/lib/api/read";
import { loadMemory } from "@/server/readmodels";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const type = params.get("type") ?? undefined;
  const view = params.get("view") === "history" ? "history" : "current";
  const limit = Number(params.get("limit") ?? 25);
  const offset = Number(params.get("offset") ?? 0);
  return handleQuery((userId) =>
    loadMemory(userId, type, view, {
      limit: Number.isFinite(limit) ? limit : 25,
      offset: Number.isFinite(offset) ? offset : 0,
    }),
  );
}
