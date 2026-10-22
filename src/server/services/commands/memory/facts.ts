import { and, desc, eq, isNull } from "drizzle-orm";
import type { Evidence, ProposedChange } from "@/lib/db/schema";
import { memories } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import type { Tx } from "../../shared/tx";

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
    agentId: string;
    type: "semantic" | "procedural";
    domain: string;
    content: string;
    confidence: number;
    salience: number;
    evidence: Evidence[];
    sourceEventId: string;
    factKey: string | null;
    value: string | null;
  },
): Promise<string> {
  const now = new Date();
  if (input.factKey) {
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
