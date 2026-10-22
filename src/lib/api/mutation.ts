import { getApiUserId } from "@/lib/auth/context";
import { ForbiddenError, toErrorResponse } from "@/lib/domain/errors";
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

    await checkRateLimit({
      userId,
      action: input.endpoint.split(":")[0],
      limit: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 60),
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
