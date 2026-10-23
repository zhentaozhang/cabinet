import { handleQueryWithRequest } from "@/lib/api/read";
import { loadCabinet } from "@/server/readmodels";

export async function GET(request: Request) {
  return handleQueryWithRequest(request, (userId) => loadCabinet(userId));
}
