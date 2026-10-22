import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditEvents } from "@/lib/db/schema";
import { newId, sha256 } from "@/lib/ids";

export type AuditInput = {
  userId: string;
  actor: string;
  action: string;
  target: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

export async function logAudit(input: AuditInput): Promise<string> {
  const [last] = await db
    .select({ hash: auditEvents.hash })
    .from(auditEvents)
    .where(eq(auditEvents.userId, input.userId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(1);

  const prevHash = last?.hash ?? null;
  const createdAt = new Date();
  const hash = sha256(
    [
      prevHash ?? "genesis",
      input.actor,
      input.action,
      input.target,
      JSON.stringify(input.before ?? null),
      JSON.stringify(input.after ?? null),
      createdAt.toISOString(),
    ].join("|"),
  );

  await db.insert(auditEvents).values({
    id: newId("aud"),
    userId: input.userId,
    actor: input.actor,
    action: input.action,
    target: input.target,
    before: input.before ?? null,
    after: input.after ?? null,
    hash,
    prevHash,
    createdAt,
  });

  return hash;
}
