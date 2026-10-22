import { handleQuery } from "@/lib/api/read";
import { loadCouncil } from "@/server/readmodels";

export async function GET() {
  return handleQuery((userId) => loadCouncil(userId));
}
