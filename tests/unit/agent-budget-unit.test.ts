import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agentBudgetReservations,
  approvals,
} from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import {
  budgetWeek,
  loadWeeklyUsage,
  reserveBudget,
} from "@/server/services/commands/tasks/execution";
import { requestApproval } from "@/server/services/commands/tasks/approvals";
import { resetDb } from "../helpers/db";

const AGENT_ID = "ag_coach"; // seeded assignee, budget_cents 1200
const TIMEZONE = "Asia/Shanghai";

beforeEach(async () => {
  await resetDb();
});

/**
 * A week whose only bucket ended before `now`.
 *
 * The bucket collides with the reservation's insert target
 * `(agent_id, period_start)`, so the row is NOT re-created, while the
 * "which bucket contains now" lookup finds nothing. That is the state in
 * which the reservation path used to dereference `undefined`.
 */
async function seedEndedBucket(now: Date): Promise<void> {
  const { periodStart } = budgetWeek(TIMEZONE, now);
  await db
    .delete(agentBudgetPeriods)
    .where(eq(agentBudgetPeriods.agentId, AGENT_ID));
  await db.insert(agentBudgetPeriods).values({
    id: `bpd_${AGENT_ID}_${periodStart.getTime()}`,
    userId: DEMO_USER_ID,
    agentId: AGENT_ID,
    timezone: TIMEZONE,
    periodStart,
    periodEnd: new Date(now.getTime() - 60_000),
    limitCents: 1200,
  });
}

/** An instant inside the seeded week, far enough from a boundary to be stable. */
const MIDWEEK = new Date("2026-05-13T02:00:00.000Z");

async function reserve(now?: Date) {
  return reserveBudget({
    userId: DEMO_USER_ID,
    agentId: AGENT_ID,
    taskId: null,
    timezone: TIMEZONE,
    amountCents: 300,
    ...(now ? { now } : {}),
  });
}

describe("reserveBudget when the period row is missing", () => {
  it("answers with a structured denial instead of throwing", async () => {
    await seedEndedBucket(MIDWEEK);

    const decision = await reserve(MIDWEEK);

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    // A missing bucket is a missing authority, never "unlimited allowance".
    expect(decision.reason).toContain("预算周期");
  });

  it("leaves no reservation behind for a period that does not exist", async () => {
    await seedEndedBucket(MIDWEEK);

    await reserve(MIDWEEK);

    const rows = await db
      .select()
      .from(agentBudgetReservations)
      .where(eq(agentBudgetReservations.agentId, AGENT_ID));
    expect(rows).toHaveLength(0);
  });

  it("does not report a missing period as a closed one", async () => {
    await seedEndedBucket(MIDWEEK);
    const missing = await reserve(MIDWEEK);
    if (missing.allowed) throw new Error("unreachable");

    await resetDb();
    const usage = await loadWeeklyUsage(AGENT_ID, TIMEZONE);
    await db
      .update(agentBudgetPeriods)
      .set({ closedAt: new Date() })
      .where(eq(agentBudgetPeriods.id, usage.periodId!));
    const closed = await reserve();
    if (closed.allowed) throw new Error("unreachable");

    expect(closed.reason).not.toBe(missing.reason);
    expect(closed.reason).toContain("关闭");
  });
});

type ApprovalRequest = Parameters<typeof requestApproval>[0];

const APPROVAL_TASK = "tsk_read";

function approvalInput(
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    userId: DEMO_USER_ID,
    taskId: APPROVAL_TASK,
    title: "读一篇论文并记笔记",
    resource: "https://example.com/paper.pdf",
    dueAt: null,
    action: "publish",
    reason: "外部动作需要你批准",
    estimatedCostCents: 300,
    ...overrides,
  };
}

async function pendingRows() {
  return db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.taskId, APPROVAL_TASK),
        eq(approvals.action, "publish"),
      ),
    );
}

describe("requestApproval transaction requirement", () => {
  it("refuses to run outside a caller transaction", async () => {
    // The advisory lock only lives as long as the transaction that took it.
    // Without one it is taken in an implicit single-statement transaction and
    // released immediately, which is no lock at all — so the call must fail
    // loudly instead of silently inserting an unprotected approval.
    const callWithoutTx = requestApproval as unknown as (
      input: ApprovalRequest,
    ) => Promise<unknown>;

    await expect(callWithoutTx(approvalInput())).rejects.toThrow(
      /caller transaction/,
    );
    expect(await pendingRows()).toHaveLength(0);
  });

  it("serialises concurrent requests for the same task and action", async () => {
    const [first, second] = await Promise.all([
      db.transaction((tx) => requestApproval(approvalInput(), tx)),
      db.transaction((tx) => requestApproval(approvalInput(), tx)),
    ]);

    expect(first.id).toBe(second.id);
    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
  });
});
