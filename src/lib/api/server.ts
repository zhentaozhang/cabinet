import { headers } from "next/headers";

import { REQUEST_ID_HEADER } from "@/lib/obs/request-id";
import { createApiClient, type ApiClient } from "./client";

/**
 * Server-side API client used by React Server Components.
 *
 * The pages never import the engine: they talk to the HTTP surface exactly like
 * a browser would. When the backend moves to its own deployment this file only
 * needs `API_BASE_URL`, and the pages stay untouched.
 */
async function resolveBaseUrl(): Promise<string> {
  const configured = process.env.API_BASE_URL;
  if (configured) return configured;

  const incoming = await headers();
  const host =
    incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "localhost:3000";
  const explicitProto = incoming.get("x-forwarded-proto");
  const proto =
    explicitProto ?? (/^(localhost|127\.)/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Headers that must survive the RSC → `/api/*` hop.
 *
 * That hop is a genuine second HTTP request, so without forwarding it would
 * mint a new identity and one page view would show up as two unrelated
 * requests in the logs — exactly the failure mode that makes an incident
 * impossible to reconstruct.
 */
function correlationHeaders(incoming: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {};

  const requestId = incoming.get(REQUEST_ID_HEADER);
  if (requestId) forwarded[REQUEST_ID_HEADER] = requestId;

  const traceparent = incoming.get("traceparent");
  if (traceparent) forwarded.traceparent = traceparent;

  const tracestate = incoming.get("tracestate");
  if (tracestate) forwarded.tracestate = tracestate;

  return forwarded;
}

export async function serverApi(): Promise<ApiClient> {
  const baseUrl = await resolveBaseUrl();
  const incoming = await headers();
  const cookie = incoming.get("cookie");
  const correlation = correlationHeaders(incoming);

  return createApiClient({
    baseUrl,
    credentials: "omit",
    headers: async (): Promise<Record<string, string>> => ({
      ...correlation,
      ...(cookie ? { cookie } : {}),
    }),
  });
}
