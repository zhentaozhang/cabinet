import { handleQuery } from "@/lib/api/read";
import { loadCabinet } from "@/server/readmodels";

export async function GET() {
  return handleQuery((userId) => loadCabinet(userId));
}
