import { getApiUserId } from "@/lib/auth/context";
import { ForbiddenError, toErrorResponse } from "@/lib/domain/errors";
import { withIdempotency } from "./idempotency";
import { envPositiveInt } from "@/lib/config/env-int";
import { checkRateLimit } from "./rate-limit";
import { currentRequestElapsedMs, runWithRequestScope } from "@/lib/observability/context";
import { logEvent } from "@/lib/observability/log";
import { withRequestIdHeader } from "./read";

type MutationResult = {
  status: number;
  /**
   * Handlers build the payload flat (`{ok:true, runId}`); the pipeline wraps it
   * into the wire envelope, so every endpoint answers the same shape as the
   * read endpoints and a client never has to guess which one it is talking to.
   */
  body: Record<string, unknown>;
};

/** `{ok:true, ...fields}` → `{ok:true, data:{...fields}}`. */
function toEnvelope(body: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...body };
  delete rest.ok;
  return { ok: true, data: rest };
}

/** Explicit origin allowlist: `TRUSTED_ORIGINS` (comma separated) + auth URL. */
export function trustedOrigins(): string[] {
  const configured = (process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const authUrl = process.env.BETTER_AUTH_URL?.replace(/\/$/, "");
  return [...new Set([...(authUrl ? [authUrl] : []), ...configured])];
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  if (!origin) {
    // Non-browser clients (curl, server-to-server) omit both headers and stay
    // allowed. Modern browsers send `Sec-Fetch-Site: cross-site` on a
    // cross-origin POST even when `Origin` is stripped by a proxy or an
    // extension, so treat that combination as hostile.
    if (fetchSite === "cross-site") {
      throw new ForbiddenError("Cross-origin request blocked.");
    }
    return;
  }

  // The allowlist comes from configuration, not from the request's own Host
  // header: a spoofed Host would otherwise make any Origin look trusted.
  const allowed = new Set(trustedOrigins());
  if (allowed.has(origin)) return;

  // A browser declares same-origin itself, and cannot be talked into it by a
  // proxy that rewrites Host.
  if (fetchSite === "same-origin") return;

  // Local development may be reached through several hostnames (127.0.0.1,
  // localhost, a LAN IP), and production must not widen the allowlist for it.
  if (process.env.NODE_ENV !== "production") {
    const host = request.headers.get("host");
    if (host && (origin === `http://${host}` || origin === `https://${host}`)) {
      return;
    }
  }

  throw new ForbiddenError("Cross-origin request blocked.");
}

/**
 * Shared mutation pipeline: CSRF → auth → rate limit → idempotency → handler.
 */
export async function handleMutation(input: {
  request: Request;
  endpoint: string;
  body?: unknown;
  handler: (userId: string) => Promise<MutationResult>;
}): Promise<Response> {
  const { result, requestId } = await runWithRequestScope(input.request, () =>
    executeMutation(input),
  );
  return withRequestIdHeader(result, requestId);
}

async function executeMutation(input: {
  request: Request;
  endpoint: string;
  body?: unknown;
  handler: (userId: string) => Promise<MutationResult>;
}): Promise<Response> {
  try {
    assertSameOrigin(input.request);
    const userId = await getApiUserId();

    // Two buckets: one per endpoint, one per user across the whole API.
    // Per-endpoint alone lets a caller multiply the budget by the number of
    // endpoints (30 routes x 60/min).
    await checkRateLimit({
      userId,
      action: "all",
      limit: envPositiveInt("RATE_LIMIT_GLOBAL_PER_MINUTE", 300),
      windowSeconds: 60,
    });
    await checkRateLimit({
      userId,
      action: input.endpoint.split(":")[0],
      limit: envPositiveInt("RATE_LIMIT_PER_MINUTE", 60),
      windowSeconds: 60,
    });

    return await withIdempotency({
      request: input.request,
      userId,
      endpoint: input.endpoint,
      body: input.body,
      handler: async () => {
        const result = await input.handler(userId);
        return { status: result.status, body: toEnvelope(result.body) };
      },
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    logEvent("warn", "mutation.failed", {
      endpoint: input.endpoint,
      ms: currentRequestElapsedMs(),
      status,
      code: body.code,
    });
    return Response.json(body, { status });
  }
}
