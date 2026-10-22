import { getApiUserId } from "@/lib/auth/context";
import { toErrorResponse } from "@/lib/domain/errors";
import { withIdempotency } from "./idempotency";

type MutationResult = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * Shared mutation pipeline: auth → idempotency → error mapping.
 */
export async function handleMutation(input: {
  request: Request;
  endpoint: string;
  body?: unknown;
  handler: (userId: string) => Promise<MutationResult>;
}): Promise<Response> {
  try {
    const userId = await getApiUserId();
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
