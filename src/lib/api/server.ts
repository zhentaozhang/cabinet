import "server-only";

import { cookies } from "next/headers";

import { createApiClient } from "./client";

/**
 * Absolute origin of the backend.
 *
 * Today the route handlers live next to the pages, so the default resolves to
 * the current Next server. After the physical split, `API_BASE_URL` points at
 * `apps/api` and this is the only line that has to change.
 */
export function resolveApiBaseUrl(): string {
  const explicit = process.env.API_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const candidate = process.env.BETTER_AUTH_URL?.trim();
  if (candidate) return candidate.replace(/\/$/, "");

  return `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
}

/**
 * Server-component client. Forwards the session cookie so the API keeps
 * enforcing the same tenancy rules whether the call comes from the browser or
 * from a server render.
 */
export const serverApi = createApiClient({
  baseUrl: resolveApiBaseUrl(),
  credentials: "omit",
  async headers() {
    const jar = await cookies();
    const cookie = jar
      .getAll()
      .map((entry) => `${entry.name}=${entry.value}`)
      .join("; ");
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    return headers;
  },
});
