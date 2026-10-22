import { handleMutation } from "@/lib/api/mutation";
import { testConnector } from "@/server/readmodels/connectors";

export const dynamic = "force-dynamic";

/** One live search, so "connected" is a measured fact rather than config. */
export function POST(request: Request) {
  return handleMutation({
    request,
    endpoint: "connectors:test",
    handler: async () => ({ status: 200, body: { ok: true, ...(await testConnector()) } }),
  });
}
