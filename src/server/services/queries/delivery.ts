import { count, desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { outbox, users } from "@/lib/db/schema";
import { smtpConfigFromEnv } from "@/lib/connectors/email";

/**
 * The delivery log is a read model of the outbox: it shows what the system
 * promised to send, whether it did, and why not. Nothing here is inferred.
 */
export async function getDeliveryData(
  userId: string,
  options: { offset?: number; limit?: number } = {},
) {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 30), 1), 100);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
  const [user] = await db
    .select({
      timezone: users.timezone,
      notifyEnabled: users.notifyEnabled,
      quietFrom: users.quietFrom,
      quietTo: users.quietTo,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const [items, statusRows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(outbox)
      .where(eq(outbox.userId, userId))
      .orderBy(desc(outbox.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ status: outbox.status, n: count() })
      .from(outbox)
      .where(eq(outbox.userId, userId))
      .groupBy(outbox.status),
    db.select({ n: count() }).from(outbox).where(eq(outbox.userId, userId)),
  ]);

  const tally: Record<string, number> = {
    pending: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };
  for (const row of statusRows) {
    tally[row.status] = Number(row.n);
  }

  const smtp = smtpConfigFromEnv();

  return {
    timezone: user?.timezone ?? "UTC",
    prefs: {
      notifyEnabled: user?.notifyEnabled ?? true,
      quietFrom: user?.quietFrom ?? 22,
      quietTo: user?.quietTo ?? 8,
    },
    email: {
      configured: smtp !== null,
      host: smtp?.host ?? null,
      from: smtp?.from ?? null,
      envVars: ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"],
    },
    counts: tally,
    total: Number(totalRow?.n ?? 0),
    offset,
    limit,
    hasMore: offset + items.length < Number(totalRow?.n ?? 0),
    items,
  };
}

/** Kept next to the query so "how many are owed" never drifts from the log. */
export async function countPending(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(outbox)
    .where(sql`${outbox.userId} = ${userId} and ${outbox.status} = 'pending'`);
  return Number(row?.n ?? 0);
}
