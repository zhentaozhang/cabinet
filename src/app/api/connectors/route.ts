import { handleQueryWithRequest } from "@/lib/api/read";
import { loadConnectors } from "@/server/readmodels/connectors";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleQueryWithRequest(request, async () => loadConnectors());
}
