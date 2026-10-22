import { and, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditEvents, users } from "@/lib/db/schema";

/**
 * One page of the audit chain, newest first.
 *
 * Actions are namespaced (`task.created`, `audit.accept`, …), so a filter is a
 * prefix match on the first segment. `kinds` is counted over the whole log so
 * the filter chips do not change size while paging.
 */
export async function getAuditPage(
  userId: string,
  options: { offset: number; limit: number; kind?: string | null },
) {
  const kind = options.kind?.trim() ? options.kind.trim() : null;

  const conditions: SQL[] = [eq(auditEvents.userId, userId)];
  if (kind) {
    conditions.push(
      sql`split_part(${auditEvents.action}, '.', 1) = ${kind}`,
    );
  }
  const where = and(...conditions) ?? eq(auditEvents.userId, userId);

  const allRows = db
    .select({ n: count() })
    .from(auditEvents)
    .where(eq(auditEvents.userId, userId));

  const [rows, totalRows, filteredRows, kindRows, userRows] = await Promise.all([
    db
      .select()
      .from(auditEvents)
      .where(where)
      .orderBy(desc(auditEvents.seq))
      .limit(options.limit)
      .offset(options.offset),
    allRows,
    kind ? db.select({ n: count() }).from(auditEvents).where(where) : allRows,
    db
      .select({
        kind: sql<string>`split_part(${auditEvents.action}, '.', 1)`,
        n: count(),
      })
      .from(auditEvents)
      .where(eq(auditEvents.userId, userId))
      .groupBy(sql`split_part(${auditEvents.action}, '.', 1)`)
      .orderBy(desc(count())),
    db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)),
  ]);

  const total = Number(totalRows[0]?.n ?? 0);
  const filteredTotal = Number(filteredRows[0]?.n ?? 0);

  return {
    timezone: userRows[0]?.timezone ?? "UTC",
    events: rows,
    kinds: kindRows.map((row) => ({ kind: row.kind, count: Number(row.n) })),
    kind,
    total,
    filteredTotal,
    offset: options.offset,
    limit: options.limit,
    hasMore: options.offset + rows.length < filteredTotal,
  };
}
