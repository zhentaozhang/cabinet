import { and, eq } from "drizzle-orm";

import { shellContextSchema, type ShellContextDto } from "@/contracts";
import { db } from "@/lib/db";
import { agents, users } from "@/lib/db/schema";
import { asDto } from "@/server/dto-guard";

/**
 * The chrome needs three facts: who you are, how many agents you have, and how
 * far up the ladder they actually are. Anything richer belongs in a page.
 */
export async function loadShell(userId: string): Promise<ShellContextDto> {
  const [user] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const rows = await db
    .select({ level: agents.autonomyLevel })
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.status, "active")));

  const levels = rows.map((row) => row.level);

  return asDto(
    shellContextSchema,
    {
      name: user?.name ?? "未登录",
      email: user?.email ?? "",
      agents: levels.length,
      autonomy: {
        l1: levels.filter((level) => level >= 1).length,
        l2: levels.filter((level) => level >= 2).length,
        l3: levels.filter((level) => level >= 3).length,
      },
    },
    "ShellContext",
  );
}
