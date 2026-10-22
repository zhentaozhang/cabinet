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

  const [countsRows, userRows] = await Promise.all([
    db
    .select({
      all: sql<number>`count(*)`,
      episodic: sql<number>`count(*) filter (where ${memories.type} = 'episodic')`,
      semantic: sql<number>`count(*) filter (where ${memories.type} = 'semantic')`,
      procedural: sql<number>`count(*) filter (where ${memories.type} = 'procedural')`,
      selected: type
        ? sql<number>`count(*) filter (where ${memories.type} = ${type})`
        : sql<number>`count(*)`,
    })
    .from(memories)
    .where(and(eq(memories.userId, userId), viewFilter)),
    db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId)),
  ]);
  const [countsRow] = countsRows;

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
    total,
    offset,
    limit,
    hasMore: offset + rows.length < total,
    view,
  };
}
