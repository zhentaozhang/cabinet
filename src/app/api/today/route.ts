import { handleQuery } from "@/lib/api/read";
import { loadToday } from "@/server/readmodels";

export async function GET() {
  return handleQuery((userId) => loadToday(userId));
}
