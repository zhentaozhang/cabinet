import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { rateLimits } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { RateLimitError } from "@/lib/domain/errors";

export async function checkRateLimit(input: {
  userId: string;
  action: string;
  limit: number;
  windowSeconds: number;
}): Promise<void> {
  const windowMs = input.windowSeconds * 1000;
  const windowStart = new Date(
    Math.floor(Date.now() / windowMs) * windowMs,
  );

  const [row] = await db
    .insert(rateLimits)
    .values({
      id: newId("rl"),
      userId: input.userId,
      action: input.action,
      windowStart,
      count: 1,
    })
    .onConflictDoUpdate({
      target: [
        rateLimits.userId,
        rateLimits.action,
        rateLimits.windowStart,
      ],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });

  if (Number(row?.count ?? 0) > input.limit) {
    throw new RateLimitError(
      `Rate limit exceeded for ${input.action}.`,
    );
  }
}
