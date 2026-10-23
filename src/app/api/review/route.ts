import { handleQueryWithRequest } from "@/lib/api/read";
import { loadReview } from "@/server/readmodels";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const limit = Number(params.get("limit") ?? 20);
  const insightOffset = Number(params.get("insightOffset") ?? 0);
  const dissentOffset = Number(params.get("dissentOffset") ?? 0);

  return handleQueryWithRequest(request, (userId) =>
    loadReview(userId, {
      limit: Number.isFinite(limit) ? limit : 20,
      insightOffset: Number.isFinite(insightOffset) ? insightOffset : 0,
      dissentOffset: Number.isFinite(dissentOffset) ? dissentOffset : 0,
    }),
  );
}
