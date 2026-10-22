import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, councilPositions, councils, users } from "@/lib/db/schema";
export async function getCouncilData(userId: string) {
  const [council] = await db
    .select()
    .from(councils)
    .where(eq(councils.userId, userId))
    .orderBy(desc(councils.createdAt))
    .limit(1);
  if (!council) return null;
  const positions = await db
    .select()
    .from(councilPositions)
    .where(eq(councilPositions.councilId, council.id))
    .orderBy(asc(councilPositions.createdAt));
  const [allAgents, userRows] = await Promise.all([
    db.select().from(agents).where(eq(agents.userId, userId)),
    db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId)),
  ]);
  return {
    timezone: userRows[0]?.timezone ?? "UTC",
    council,
    positions,
    agents: allAgents,
  };
}
