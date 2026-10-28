import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { retrievalCalls, users } from "@/lib/db/schema";
import {
  retrievalUnitPriceCents,
  retrievalWeeklyBudgetCents,
} from "@/lib/config/pricing";
import { weekRange } from "@/lib/domain/time";
import { newId } from "@/lib/ids";
import { statusImpliesContact } from "@/lib/domain/contact";
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
  // 只有真的发出过请求才可能被计费。`not_connected` 是"根本没有连接器"，
  // 请求一个字节都没离开进程，而同一件事在预算台账里已经记成 not_contacted
  //（见 tool-loop 的 settleBudget）。两处若各写一个答案，"本周检索花费"
  // 会凭空多出一笔，周上限也会被这些没发生的调用一点点耗尽。
  // 单价照样落库：它记的是"当时的价格"，不是"花掉的钱"。
  const charged = statusImpliesContact(input.status) ? priced : 0;
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
    chargedCents: charged,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
  });
}

/**
 * How much of this week's retrieval ceiling is already gone.
 *
 * Cheap enough to call before every outbound request (one aggregate over an
 * indexed window), which is the point: a ceiling checked after the spend is a
 * report, not a limit.
 */
export async function retrievalBudgetState(userId: string): Promise<{
  limitCents: number;
  spentCents: number;
  exhausted: boolean;
}> {
  const limitCents = retrievalWeeklyBudgetCents();
  const [user] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId));
  const range = weekRange(new Date(), user?.timezone ?? "UTC");

  const [row] = await db
    .select({ spent: sql<number>`coalesce(sum(${retrievalCalls.chargedCents}), 0)` })
    .from(retrievalCalls)
    .where(
      and(
        eq(retrievalCalls.userId, userId),
        gte(retrievalCalls.createdAt, range.start),
        lt(retrievalCalls.createdAt, range.end),
      ),
    );

  const spentCents = Number(row?.spent ?? 0);
  return {
    limitCents,
    spentCents,
    // No configured ceiling means no ceiling; it does not mean zero.
    exhausted: limitCents > 0 && spentCents >= limitCents,
  };
}
