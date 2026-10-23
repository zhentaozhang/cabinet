import { handleQueryWithRequest } from "@/lib/api/read";
import { loadCouncil } from "@/server/readmodels";

export async function GET(request: Request) {
  return handleQueryWithRequest(request, (userId) => loadCouncil(userId));
}
