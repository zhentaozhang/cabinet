import { handleQueryWithRequest } from "@/lib/api/read";
import { loadTask } from "@/server/readmodels";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleQueryWithRequest(request, (userId) => loadTask(id, userId));
}
