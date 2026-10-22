import { handleQuery } from "@/lib/api/read";
import { loadShell } from "@/server/readmodels";

export async function GET() {
  return handleQuery((userId) => loadShell(userId));
}
