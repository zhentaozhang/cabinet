import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditEvents } from "@/lib/db/schema";
import { canonicalJson, newId, sha256 } from "@/lib/ids";

export type AuditInput = {
  userId: string;
  actor: string;
  action: string;
  target: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

function hashEvent(input: {
  prevHash: string | null;
  actor: string;
  action: string;
  target: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: Date;
}): string {
  return sha256(
    [
      input.prevHash ?? "genesis",
      input.actor,
      input.action,
      input.target,
      canonicalJson(input.before ?? null),
      canonicalJson(input.after ?? null),
      input.createdAt.toISOString(),
    ].join("|"),
  );
}

export type AuditTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Append to the hash chain inside an existing business transaction. This keeps
 * the state change and its audit event atomic.
 */
export async function logAuditTx(
  tx: AuditTx,
  input: AuditInput,
): Promise<string> {
  // Serialize chain appends per user.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${input.userId}))`,
  );

  const [last] = await tx
    .select({ hash: auditEvents.hash })
    .from(auditEvents)
    .where(eq(auditEvents.userId, input.userId))
    .orderBy(desc(auditEvents.seq))
    .limit(1);

  const prevHash = last?.hash ?? null;
  const createdAt = new Date();
  const hash = hashEvent({
    prevHash,
    actor: input.actor,
    action: input.action,
    target: input.target,
    before: input.before ?? null,
    after: input.after ?? null,
    createdAt,
  });

  await tx.insert(auditEvents).values({
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

export async function logAudit(input: AuditInput): Promise<string> {
  return db.transaction((tx) => logAuditTx(tx, input));
}

export async function verifyAuditChain(userId: string): Promise<{
  ok: boolean;
  checked: number;
  firstMismatch: string | null;
}> {
  const events = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.userId, userId))
    .orderBy(asc(auditEvents.seq));

  let prevHash: string | null = null;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expected = hashEvent({
      prevHash,
      actor: event.actor,
      action: event.action,
      target: event.target,
      before: event.before,
      after: event.after,
      createdAt: event.createdAt,
    });

    if (event.prevHash !== prevHash || event.hash !== expected) {
      return {
        ok: false,
        checked: index,
        firstMismatch: event.id,
      };
    }
    prevHash = event.hash;
  }

  return { ok: true, checked: events.length, firstMismatch: null };
}
