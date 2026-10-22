import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { idempotencyKeys } from "@/lib/db/schema";
import { ConflictError } from "@/lib/domain/errors";
import { canonicalJson, newId, sha256 } from "@/lib/ids";

type HandlerResult = {
  status: number;
  body: Record<string, unknown>;
};

type StoredKey = {
  requestHash: string;
  status: string;
  statusCode: number;
  responseJson: Record<string, unknown> | null;
};

function replay(stored: StoredKey, requestHash: string): Response {
  if (stored.requestHash !== requestHash) {
    throw new ConflictError(
      "Idempotency-Key was reused with a different request body.",
    );
  }
  if (stored.status !== "completed") {
    throw new ConflictError(
      "A request with this Idempotency-Key is already in progress.",
    );
  }
  return Response.json(stored.responseJson ?? { ok: true }, {
    status: stored.statusCode,
    headers: { "Idempotency-Replayed": "true" },
  });
}

/**
 * Replay-safe mutation wrapper.
 *
 * - No header: execute normally (backwards compatible).
 * - Same key + same request hash: return the first response.
 * - Same key + different hash: 409 conflict.
 * - Concurrent same key: one wins, the other gets 409 in-progress.
 */
export async function withIdempotency(input: {
  request: Request;
  userId: string;
  endpoint: string;
  body?: unknown;
  handler: () => Promise<HandlerResult>;
}): Promise<Response> {
  const key = input.request.headers.get("Idempotency-Key");
  if (!key) {
    const result = await input.handler();
    return Response.json(result.body, { status: result.status });
  }

  const requestHash = sha256(
    [
      input.userId,
      input.request.method,
      input.endpoint,
      canonicalJson(input.body ?? null),
    ].join("|"),
  );

  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, input.userId),
        eq(idempotencyKeys.key, key),
      ),
    )
    .limit(1);

  if (existing) {
    return replay(existing, requestHash);
  }

  let insertError: unknown = null;
  try {
    await db.insert(idempotencyKeys).values({
      id: newId("idem"),
      userId: input.userId,
      key,
      endpoint: input.endpoint,
      requestHash,
      status: "processing",
      statusCode: 200,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
  } catch (error) {
    insertError = error;
  }

  if (insertError) {
    const [concurrent] = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, input.userId),
          eq(idempotencyKeys.key, key),
        ),
      )
      .limit(1);
    if (concurrent) return replay(concurrent, requestHash);
    throw insertError;
  }

  try {
    const result = await input.handler();
    await db
      .update(idempotencyKeys)
      .set({
        status: "completed",
        statusCode: result.status,
        responseJson: result.body,
      })
      .where(
        and(
          eq(idempotencyKeys.userId, input.userId),
          eq(idempotencyKeys.key, key),
        ),
      );
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    await db
      .update(idempotencyKeys)
      .set({ status: "failed" })
      .where(
        and(
          eq(idempotencyKeys.userId, input.userId),
          eq(idempotencyKeys.key, key),
        ),
      );
    throw error;
  }
}
