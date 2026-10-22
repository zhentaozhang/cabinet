import { getApiUserId } from "@/lib/auth/context";
import { NotFoundError, toErrorResponse } from "@/lib/domain/errors";
import { bindUser } from "@/lib/obs/context";
import { runHttpRequest } from "@/lib/obs/http";

/**
 * Shared read pipeline: auth → loader → `{ ok: true, data }`.
 *
 * Reads deliberately skip rate limiting and idempotency (they are safe to
 * retry), but they still resolve the owning user, so a loader can never be
 * tricked into reading another tenant's rows.
 *
 * The whole pipeline runs inside the request observation context, which is what
 * gives every GET handler an access log without instrumenting 26 call sites.
 */
export async function handleQuery<T>(
  loader: (userId: string) => Promise<T | null>,
): Promise<Response> {
  return runHttpRequest("query", async () => {
    try {
      const userId = await getApiUserId();
      bindUser(userId);

      const data = await loader(userId);
      if (data === null) throw new NotFoundError("Not found");
      return Response.json({ ok: true, data });
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return Response.json(body, { status });
    }
  });
}
