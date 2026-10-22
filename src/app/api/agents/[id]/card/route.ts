import { handleQuery } from "@/lib/api/read";
import { loadAgentCard } from "@/server/readmodels";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleQuery((userId) => loadAgentCard(userId, id));
}
