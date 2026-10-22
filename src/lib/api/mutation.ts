import { getApiUserId } from "@/lib/auth/context";
import { ForbiddenError, toErrorResponse } from "@/lib/domain/errors";
import { bindUser, logEvent } from "@/lib/obs/context";
import { runHttpRequest } from "@/lib/obs/http";
import { withIdempotency } from "./idempotency";
import { checkRateLimit } from "./rate-limit";

type MutationResult = {
  status: number;
  body: Record<string, unknown>;
};

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return; // non-browser client

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
 *
 * `endpoint` doubles as the observability label (`task.run`, `memory.delete`):
 * a bounded enum, unlike the request path, so it is safe to aggregate on.
 */
export async function handleMutation(input: {
  request: Request;
  endpoint: string;
  body?: unknown;
  handler: (userId: string) => Promise<MutationResult>;
}): Promise<Response> {
  return runHttpRequest("mutation", async () => {
    try {
      assertSameOrigin(input.request);
      const userId = await getApiUserId();
      bindUser(userId);

      await checkRateLimit({
        userId,
        action: input.endpoint.split(":")[0],
        limit: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 60),
        windowSeconds: 60,
      });

      const response = await withIdempotency({
        request: input.request,
        userId,
        endpoint: input.endpoint,
        body: input.body,
        handler: () => input.handler(userId),
      });

      logEvent("info", "mutation.committed", {
        endpoint: input.endpoint,
        status: response.status,
        replayed: response.headers.get("idempotency-replayed") === "true",
      });

      return response;
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return Response.json(body, { status });
    }
  });
}
