import { getApiUserId } from "@/lib/auth/context";
import { NotFoundError, toErrorResponse } from "@/lib/domain/errors";
import {
  currentRequestElapsedMs,
  runWithRequestScope,
} from "@/lib/observability/context";
import { logEvent } from "@/lib/observability/log";

/** Attach the id so a user can quote it when reporting a bad answer. */
export async function withRequestIdHeader(
  response: Response,
  requestId: string,
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(await response.text(), {
    status: response.status,
    headers,
  });
}

/**
 * Shared read pipeline: auth → loader → `{ ok: true, data }`.
 *
 * Reads deliberately skip rate limiting and idempotency (they are safe to
 * retry), but they still resolve the owning user, so a loader can never be
 * tricked into reading another tenant's rows.
 */
export async function handleQuery<T>(
  loader: (userId: string) => Promise<T | null>,
  request?: Request,
): Promise<Response> {
  const scope = async () => {
    try {
      const userId = await getApiUserId();
      const data = await loader(userId);
      if (data === null) throw new NotFoundError("Not found");
      logEvent("info", "query.ok", { ms: currentRequestElapsedMs() });
      return Response.json({ ok: true, data });
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      logEvent("warn", "query.failed", {
        ms: currentRequestElapsedMs(),
        status,
        code: body.code,
      });
      return Response.json(body, { status });
    }
  };

  if (!request) return scope();

  const { result, requestId } = await runWithRequestScope(request, scope);
  return withRequestIdHeader(result, requestId);
}

/** `handleQuery` for routes that already have the request in hand. */
export function handleQueryWithRequest<T>(
  request: Request,
  loader: (userId: string) => Promise<T | null>,
): Promise<Response> {
  return handleQuery(loader, request);
}
