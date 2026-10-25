import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { mcpServers } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { newId } from "@/lib/ids";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
  await db.delete(mcpServers).where(eq(mcpServers.userId, DEMO_USER_ID));
});

function row(overrides: Partial<typeof mcpServers.$inferInsert> = {}) {
  return {
    id: newId("mcs"),
    userId: DEMO_USER_ID,
    name: "github",
    url: "https://mcp.example.com/mcp",
    resource: "mcp:github",
    ...overrides,
  } satisfies typeof mcpServers.$inferInsert;
}

describe("mcp_servers", () => {
  it("defaults to enabled and read-only", async () => {
    const [inserted] = await db.insert(mcpServers).values(row()).returning();
    expect(inserted!.enabled).toBe(true);
    expect(inserted!.scope).toBe("read");
  });

  it("keeps one name per user", async () => {
    await db.insert(mcpServers).values(row());
    await expect(db.insert(mcpServers).values(row())).rejects.toThrow();
  });

  it("stores the resource a grant has to name", async () => {
    const [inserted] = await db
      .insert(mcpServers)
      .values(row({ resource: "mcp:internal-wiki", scope: "write" }))
      .returning();
    expect(inserted!.resource).toBe("mcp:internal-wiki");
    expect(inserted!.scope).toBe("write");
  });
});
