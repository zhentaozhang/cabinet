import { and, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { memories, users } from "@/lib/db/schema";

export type MemoryView = "current" | "history";

export type MemoryPageOptions = {
  limit?: number;
  offset?: number;
};

export async function getMemoryData(
  userId: string,
  type?: string,
  view: MemoryView = "current",
  options: MemoryPageOptions = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const viewFilter =
    view === "history"
      ? isNotNull(memories.validTo)
      : isNull(memories.validTo);

  const [countsRows, userRows, conflictRows] = await Promise.all([
    db
    .select({
      all: sql<number>`count(*)`,
      episodic: sql<number>`count(*) filter (where ${memories.type} = 'episodic')`,
      semantic: sql<number>`count(*) filter (where ${memories.type} = 'semantic')`,
      procedural: sql<number>`count(*) filter (where ${memories.type} = 'procedural')`,
      selected: type
        ? sql<number>`count(*) filter (where ${memories.type} = ${type})`
        : sql<number>`count(*)`,
      // The card row above the list reports library-wide numbers. The average
      // confidence stays scoped to the tab on screen: a closed row is not a
      // current belief. Conflicts are counted in their own query below, because
      // `writeMemoryFact` closes the rejected claim the moment it records the
      // conflict, so they never appear in this tab at all.
      avgConfidence: sql<number | null>`avg(${memories.confidence})`,
    })
    .from(memories)
    .where(and(eq(memories.userId, userId), viewFilter)),
    db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId)),
    /*
     * Whole-library, both tabs. A conflict is an open question for the user, not
     * a row of one tab: the rejected claim is stored closed (`validTo = now`,
     * `status = "conflicted"`), so scoping this to the current tab made the
     * tile read 0 forever while the Cabinet page — which tallies every memory —
     * said "N 条自相矛盾，待你裁定" about the same rows.
     */
    db
      .select({ count: sql<number>`count(*)` })
      .from(memories)
      .where(
        and(
          eq(memories.userId, userId),
          eq(memories.status, "conflicted"),
        ),
      ),
  ]);
  const [countsRow] = countsRows;
  const [conflictRow] = conflictRows;

  const [staleRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        viewFilter,
        lt(memories.expiresAt, new Date()),
      ),
    );

  const rows = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        viewFilter,
        type ? eq(memories.type, type) : undefined,
      ),
    )
    .orderBy(desc(memories.createdAt), desc(memories.id))
    .limit(limit)
    .offset(offset);

  const counts = {
    all: Number(countsRow?.all ?? 0),
    episodic: Number(countsRow?.episodic ?? 0),
    semantic: Number(countsRow?.semantic ?? 0),
    procedural: Number(countsRow?.procedural ?? 0),
  };
  const total = Number(countsRow?.selected ?? 0);

  return {
    timezone: userRows[0]?.timezone ?? "UTC",
    memories: rows,
    counts,
    stale: Number(staleRow?.count ?? 0),
    conflicts: Number(conflictRow?.count ?? 0),
    // `avg` comes back as a string (Postgres numeric) or null on an empty table;
    // null must stay null so the card says "暂无记忆" instead of reporting 0%.
    avgConfidence:
      countsRow?.avgConfidence === null || countsRow?.avgConfidence === undefined
        ? null
        : Number(countsRow.avgConfidence),
    total,
    offset,
    limit,
    hasMore: offset + rows.length < total,
    view,
  };
}
