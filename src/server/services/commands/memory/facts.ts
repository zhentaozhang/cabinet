import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Evidence, ProposedChange } from "@/lib/db/schema";
import { memories } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import type { Tx } from "../../shared/tx";

/**
 * Conflict rule for an active `factKey` (no schema change required):
 *
 * - A conflicting write may supersede the active fact only when it carries
 *   explicit user authority (an insight the user accepted) or when it is an
 *   auto-generated write that is at least as confident as the incumbent and
 *   clears `AUTO_SUPERSEDE_MIN_CONFIDENCE`.
 * - Otherwise the active fact keeps its place and the conflicting claim is
 *   stored as history (`validTo = now`, `status = "conflicted"`): it is never
 *   retrieved, but the disagreement is still recorded instead of being
 *   silently overwritten.
 *
 * `expiresAt` is intentionally not set here: policy_config has no episodic
 * retention value, so choosing a TTL in code would hide policy in a constant.
 */
const AUTO_SUPERSEDE_MIN_CONFIDENCE = 0.8;

export type MemoryWriteAuthority = "user" | "auto";

export function factSlug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "rule"
  );
}

export function factForChange(
  change: ProposedChange,
): { factKey: string; value: string } | null {
  if (change.type === "reschedule" && change.taskId) {
    return { factKey: `schedule:${change.taskId}`, value: change.to };
  }
  if (change.type === "split_task" && change.taskId) {
    return {
      factKey: `task:${change.taskId}:split`,
      value: String(change.minutes),
    };
  }
  if (change.type === "add_rule") {
    return { factKey: `rule:${factSlug(change.rule)}`, value: change.rule };
  }
  return null;
}

export async function writeMemoryFact(
  tx: Tx,
  input: {
    userId: string;
    agentId: string | null;
    type: "semantic" | "procedural";
    domain: string;
    content: string;
    confidence: number;
    salience: number;
    evidence: Evidence[];
    sourceEventId: string;
    factKey: string | null;
    value: string | null;
    /** `"user"` only when the user explicitly accepted the claim. */
    authority?: MemoryWriteAuthority;
  },
): Promise<string> {
  const now = new Date();
  if (input.factKey) {
    // Serialize writers for the same active fact. The partial unique index is a
    // second line of defense, but this keeps the read-then-write path simple.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${input.userId}:${input.factKey}`}))`,
    );
    const [existing] = await tx
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, input.userId),
          eq(memories.factKey, input.factKey),
          isNull(memories.validTo),
        ),
      )
      .orderBy(desc(memories.validFrom))
      .limit(1);

    if (existing) {
      if (existing.value === input.value) {
        await tx
          .update(memories)
          .set({ lastConfirmedAt: now })
          .where(eq(memories.id, existing.id));
        return existing.id;
      }

      const nextId = newId("mem");
      const canSupersede =
        input.authority === "user" ||
        (input.confidence >= AUTO_SUPERSEDE_MIN_CONFIDENCE &&
          input.confidence >= existing.confidence);

      if (!canSupersede) {
        await tx.insert(memories).values({
          id: nextId,
          userId: input.userId,
          agentId: input.agentId,
          type: input.type,
          domain: input.domain,
          content: input.content,
          factKey: input.factKey,
          value: input.value,
          validFrom: now,
          // Closed immediately so the partial unique index stays one-active-per-
          // fact and retrieval never surfaces the rejected claim.
          validTo: now,
          confidence: input.confidence,
          salience: input.salience,
          evidence: input.evidence,
          sourceEventId: input.sourceEventId,
          lastConfirmedAt: now,
          status: "conflicted",
        });
        return nextId;
      }

      await tx
        .update(memories)
        .set({
          validTo: now,
          supersededBy: nextId,
          status: "superseded",
        })
        .where(eq(memories.id, existing.id));

      await tx.insert(memories).values({
        id: nextId,
        userId: input.userId,
        agentId: input.agentId,
        type: input.type,
        domain: input.domain,
        content: input.content,
        factKey: input.factKey,
        value: input.value,
        validFrom: now,
        confidence: input.confidence,
        salience: input.salience,
        evidence: input.evidence,
        sourceEventId: input.sourceEventId,
        lastConfirmedAt: now,
        status: "active",
      });
      return nextId;
    }
  }

  const id = newId("mem");
  await tx.insert(memories).values({
    id,
    userId: input.userId,
    agentId: input.agentId,
    type: input.type,
    domain: input.domain,
    content: input.content,
    factKey: input.factKey,
    value: input.value,
    validFrom: now,
    confidence: input.confidence,
    salience: input.salience,
    evidence: input.evidence,
    sourceEventId: input.sourceEventId,
    lastConfirmedAt: now,
    status: "active",
  });
  return id;
}

/**
 * Invalidate the memories an applied insight wrote, inside the rollback
 * transaction. This is a soft invalidation: the row stays for history, but it
 * stops being current so retrieval skips it.
 *
 * When the invalidated memory is still the current version of a `factKey` and
 * it had superseded a previous version, that previous version becomes current
 * again. It is only restored when it is still a plain `superseded` row and no
 * newer version has taken over in the meantime.
 */
export async function rollbackMemoryForSource(
  tx: Tx,
  input: { userId: string; sourceEventId: string },
): Promise<void> {
  const now = new Date();
  const rows = await tx
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.userId, input.userId),
        eq(memories.sourceEventId, input.sourceEventId),
      ),
    );

  for (const memory of rows) {
    if (memory.status === "rolled_back") continue;
    const wasCurrent = memory.validTo === null;

    await tx
      .update(memories)
      .set({ validTo: memory.validTo ?? now, status: "rolled_back" })
      .where(eq(memories.id, memory.id));

    if (!wasCurrent || !memory.factKey) continue;

    const [newer] = await tx
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.userId, input.userId),
          eq(memories.factKey, memory.factKey),
          isNull(memories.validTo),
          ne(memories.id, memory.id),
        ),
      )
      .limit(1);
    if (newer) continue;

    const [previous] = await tx
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, input.userId),
          eq(memories.factKey, memory.factKey),
          eq(memories.supersededBy, memory.id),
        ),
      )
      .orderBy(desc(memories.validFrom))
      .limit(1);
    if (!previous || previous.status !== "superseded") continue;

    await tx
      .update(memories)
      .set({ validTo: null, supersededBy: null, status: "active" })
      .where(eq(memories.id, previous.id));
  }
}
