import { getApiUserId } from "@/lib/auth/context";
import { NotFoundError, toErrorResponse } from "@/lib/domain/errors";

/**
 * Shared read pipeline: auth → loader → `{ ok: true, data }`.
 *
 * Reads deliberately skip rate limiting and idempotency (they are safe to
 * retry), but they still resolve the owning user, so a loader can never be
 * tricked into reading another tenant's rows.
 */
export async function handleQuery<T>(
  loader: (userId: string) => Promise<T | null>,
): Promise<Response> {
  try {
    const userId = await getApiUserId();
    const data = await loader(userId);
    if (data === null) throw new NotFoundError("Not found");
    return Response.json({ ok: true, data });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
