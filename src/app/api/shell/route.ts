import { handleQueryWithRequest } from "@/lib/api/read";
import { loadShell } from "@/server/readmodels";

export async function GET(request: Request) {
  return handleQueryWithRequest(request, (userId) => loadShell(userId));
}
