import { handleQueryWithRequest } from "@/lib/api/read";
import { loadToday } from "@/server/readmodels";

export async function GET(request: Request) {
  return handleQueryWithRequest(request, (userId) => loadToday(userId));
}
