import { handleQuery } from "@/lib/api/read";
import { loadAudit } from "@/server/readmodels";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const limit = Number(params.get("limit") ?? 40);
  const offset = Number(params.get("offset") ?? 0);
  const kind = params.get("kind");
  return handleQuery((userId) =>
    loadAudit(userId, {
      limit: Number.isFinite(limit) ? limit : 40,
      offset: Number.isFinite(offset) ? offset : 0,
      kind: kind && kind.trim() ? kind.trim() : null,
    }),
  );
}
