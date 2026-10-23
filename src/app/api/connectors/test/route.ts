import { handleMutation } from "@/lib/api/mutation";
import { testConnector } from "@/server/readmodels/connectors";

export const dynamic = "force-dynamic";

/**
 * A probe may fall through to the fallback provider, so the worst case is two
 * connector timeouts, not one. Keep the handler alive long enough to report the
 * failure instead of the platform timing out first.
 */
export const maxDuration = 30;

/**
 * One live search, so "connected" is a measured fact rather than configuration.
 *
 * This is the only way to reach a probe: rendering `/settings/connectors` reads
 * configuration only. The body is the standard mutation envelope (`ok` plus
 * fields) and never contains a credential — a provider message names the
 * environment variable, never its value.
 */
export function POST(request: Request) {
  return handleMutation({
    request,
    endpoint: "connectors:test",
    handler: async () => ({
      status: 200,
      body: { ok: true, ...(await testConnector()) },
    }),
  });
}
