import { getApiUserId } from "@/lib/auth/context";
import { ForbiddenError, toErrorResponse } from "@/lib/domain/errors";
import { withIdempotency } from "./idempotency";
import { envPositiveInt } from "@/lib/config/env-int";
import { checkRateLimit } from "./rate-limit";

type MutationResult = {
  status: number;
  body: Record<string, unknown>;
};

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

  const host = request.headers.get("host");
  const allowed = new Set(
    [
      process.env.BETTER_AUTH_URL,
      host ? `http://${host}` : null,
      host ? `https://${host}` : null,
    ].filter((value): value is string => Boolean(value)),
  );

  if (!allowed.has(origin)) {
    throw new ForbiddenError("Cross-origin request blocked.");
  }
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
      handler: () => input.handler(userId),
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
