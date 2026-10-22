import { headers } from "next/headers";

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

export async function serverApi(): Promise<ApiClient> {
  const baseUrl = await resolveBaseUrl();
  const incoming = await headers();
  const cookie = incoming.get("cookie");

  return createApiClient({
    baseUrl,
    credentials: "omit",
    headers: async (): Promise<Record<string, string>> =>
      cookie ? { cookie } : {},
  });
}
