import { db } from "@/lib/db";
import { retrievalCalls } from "@/lib/db/schema";
import { retrievalUnitPriceCents } from "@/lib/config/pricing";
import { newId } from "@/lib/ids";
import type { ToolStepStatus } from "@/lib/domain/tool-plan";

/**
 * Record what an outbound call actually was, including the price of the day.
 *
 * Best placed next to the call rather than derived later from tool steps: the
 * step is a UI trace, this is the money. A call that returned no citable hit
 * still belongs here — it was still paid for.
 */
export async function recordRetrievalCall(input: {
  userId: string;
  taskId?: string | null;
  runId?: string | null;
  tool: string;
  provider: string | null;
  status: ToolStepStatus;
  hits: number;
  latencyMs: number;
  /** Fetching a named page is free; searching is billed per request. */
  billable: boolean;
}): Promise<void> {
  const priced = input.billable ? retrievalUnitPriceCents() : 0;
  await db.insert(retrievalCalls).values({
    id: newId("rtc"),
    userId: input.userId,
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
    tool: input.tool,
    provider: input.provider ?? "none",
    status: input.status,
    hits: input.hits,
    unitPriceCents: priced,
    chargedCents: priced,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
  });
}
