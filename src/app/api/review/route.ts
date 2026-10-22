import { handleQuery } from "@/lib/api/read";
import { loadReview } from "@/server/readmodels";

export async function GET() {
  return handleQuery((userId) => loadReview(userId));
}
