import { handleQueryWithRequest } from "@/lib/api/read";
import { loadAgentCard } from "@/server/readmodels";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleQueryWithRequest(request, (userId) => loadAgentCard(userId, id));
}
