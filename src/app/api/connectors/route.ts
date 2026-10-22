import { handleQuery } from "@/lib/api/read";
import { loadConnectors } from "@/server/readmodels/connectors";

export const dynamic = "force-dynamic";

export function GET() {
  return handleQuery(async () => loadConnectors());
}
