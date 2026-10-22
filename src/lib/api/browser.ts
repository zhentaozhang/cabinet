import { createApiClient, idempotencyKey } from "./client";

/**
 * Browser client. Same-origin by default; after the physical split point
 * `NEXT_PUBLIC_API_BASE_URL` at the API origin and switch credentials to
 * "include" (plus CORS on the API side).
 */
export const browserApi = createApiClient({
  baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? "",
  credentials: "same-origin",
});

export { idempotencyKey };
