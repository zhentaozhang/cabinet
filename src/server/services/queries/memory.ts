import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { memories } from "@/lib/db/schema";
export type MemoryView = "current" | "history";

export async function getMemoryData(
  userId: string,
  type?: string,
  view: MemoryView = "current",
) {
  const all = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        view === "history"
          ? isNotNull(memories.validTo)
          : isNull(memories.validTo),
      ),
    )
    .orderBy(desc(memories.salience));
  const filtered = type ? all.filter((m) => m.type === type) : all;
  const counts = {
    all: all.length,
    episodic: all.filter((m) => m.type === "episodic").length,
    semantic: all.filter((m) => m.type === "semantic").length,
    procedural: all.filter((m) => m.type === "procedural").length,
  };
  const now = Date.now();
  const stale = all.filter(
    (m) => m.expiresAt && new Date(m.expiresAt).getTime() < now,
  ).length;
  return { memories: filtered, counts, stale, view };
}
