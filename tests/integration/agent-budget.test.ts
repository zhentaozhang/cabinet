import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, gte, isNotNull } from "drizzle-orm";

const harness = vi.hoisted(() => ({
  impl: null as null | ((input: unknown) => Promise<unknown>),
}));

vi.mock("@/lib/llm", () => ({
  generateArtifact: (input: unknown) => harness.impl!(input),
}));

import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agentBudgetReservations,
  agents,
  policyConfig,
  runs,
} from "@/lib/db/schema";
import { RUN_COST_CENTS } from "@/lib/db/seed";
import { DEMO_USER_ID } from "@/lib/demo";
import { startOfLocalWeek } from "@/lib/domain/time";
import { loadWeeklyUsage, reserveBudget } from "@/server/services/commands/tasks/execution";
import { runTask } from "@/server/services/commands/tasks/run";
import { resetDb } from "../helpers/db";

const TASK_ID = "tsk_read";
const AGENT_ID = "ag_coach"; // seeded assignee, budget_cents 1200
const TIMEZONE = "Asia/Shanghai";

/** The demo seed already settled this Agent's current-week run (¥1.80). */
const SEEDED_SETTLED_CENTS = RUN_COST_CENTS.quiz;

async function runTaskOnce(): Promise<void> {
  await runTask(TASK_ID, DEMO_USER_ID);
}

async function periodRows() {
  return db
    .select()
    .from(agentBudgetPeriods)
    .where(eq(agentBudgetPeriods.agentId, AGENT_ID));
}

async function reservationRows() {
  return db
    .select()
    .from(agentBudgetReservations)
    .where(eq(agentBudgetReservations.agentId, AGENT_ID));
}

/** Seeds the current period bucket with `settledCents` already spent. */
async function seedSettled(settledCents: number): Promise<void> {
  const usage = await loadWeeklyUsage(AGENT_ID, TIMEZONE);
  await db
    .update(agentBudgetPeriods)
    .set({ settledCents })
    .where(eq(agentBudgetPeriods.id, usage.periodId!));
}

beforeEach(async () => {
  await resetDb();
  harness.impl = null;
});

afterEach(() => {
  delete process.env.DEMO_MODE;
});

const liveCtx = { provider: "openai", model: "gpt-4.1-mini" };

describe("weekly budget ledger", () => {
  it("settles measured usage once and releases the hold", async () => {
    harness.impl = async () => ({
      status: "success",
      ...liveCtx,
      attemptId: "att_known",
      costSource: "actual",
      draft: { title: "标题", content: "正文", tokensIn: 111, tokensOut: 222 },
    });

    await runTaskOnce();

    const [period] = await periodRows();
    const [reservation] = await reservationRows();

    // (111 + 222) / 1000 * 0.8 = 0.2664 → 0.27, added on top of the seeded ¥1.80
    expect(reservation.state).toBe("settled");
    expect(reservation.providerAttemptId).toBe("att_known");
    expect(reservation.settledCents).toBeCloseTo(0.27, 5);
    expect(period.reservedCents).toBe(0);
    expect(period.settledCents).toBeCloseTo(SEEDED_SETTLED_CENTS + 0.27, 5);
    expect(period.unknownCents).toBe(0);
    expect(period.overrun).toBe(false);
  });

  it("creates no provider usage for a demo-mode template draft", async () => {
    process.env.DEMO_MODE = "true";
    harness.impl = async () => ({ status: "not_configured", attemptId: null });

    const result = await runTask(TASK_ID, DEMO_USER_ID);
    expect("runId" in result).toBe(true);

    // The template fallback never contacted a provider: the hold is released and
    // the period records no measured or unknown usage. The seeded ¥1.80 stays as
    // the only settled amount, which is why the assertions are deltas.
    const [reservation] = await reservationRows();
    expect(reservation.state).toBe("released");
    const [period] = await periodRows();
    expect(period.settledCents).toBe(SEEDED_SETTLED_CENTS);
    expect(period.unknownCents).toBe(0);
    expect(period.reservedCents).toBe(0);
  });

  it("keeps unknown usage as conservative exposure, not a measured charge", async () => {
    harness.impl = async () => ({
      status: "timeout",
      ...liveCtx,
      attemptId: "att_timeout",
      costSource: "unknown",
    });

    await expect(runTaskOnce()).rejects.toThrow();

    const [period] = await periodRows();
    const [reservation] = await reservationRows();

    expect(reservation.state).toBe("unknown_charged");
    expect(reservation.providerAttemptId).toBe("att_timeout");
    expect(period.unknownCents).toBe(50); // the full maxRunCents reservation
    expect(period.settledCents).toBe(SEEDED_SETTLED_CENTS); // no measured charge added
    expect(period.reservedCents).toBe(0);
  });

  it("releases the hold when no provider was ever contacted", async () => {
    harness.impl = async () => ({ status: "not_configured", attemptId: null });

    await expect(runTaskOnce()).rejects.toThrow(/not configured/i);

    const [period] = await periodRows();
    const [reservation] = await reservationRows();

    expect(reservation.state).toBe("released");
    expect(reservation.settledCents).toBe(0);
    expect(period.reservedCents).toBe(0);
    expect(period.settledCents).toBe(SEEDED_SETTLED_CENTS);
    expect(period.unknownCents).toBe(0);
  });

  it("reserves before the provider request is sent", async () => {
    let heldAtCallTime = 0;
    harness.impl = async () => {
      const [held] = await db
        .select()
        .from(agentBudgetReservations)
        .where(
          and(
            eq(agentBudgetReservations.agentId, AGENT_ID),
            eq(agentBudgetReservations.state, "reserved"),
          ),
        );
      heldAtCallTime = held?.amountCents ?? 0;
      return {
        status: "success",
        ...liveCtx,
        attemptId: "att_order",
        costSource: "actual",
        draft: { title: "标题", content: "正文", tokensIn: 10, tokensOut: 10 },
      };
    };

    await runTaskOnce();
    expect(heldAtCallTime).toBe(50);
  });

  it("cannot let two concurrent reservations both take the last allowance", async () => {
    await seedSettled(1150); // 1200 - 1150 = 50 remaining

    const attempt = () =>
      reserveBudget({
        userId: DEMO_USER_ID,
        agentId: AGENT_ID,
        taskId: TASK_ID,
        timezone: TIMEZONE,
        amountCents: 50,
      });

    const [first, second] = await Promise.all([attempt(), attempt()]);
    const allowed = [first, second].filter((result) => result.allowed);

    expect(allowed).toHaveLength(1);
    const denied = [first, second].find((result) => !result.allowed);
    expect(denied && denied.allowed === false && denied.reason).toContain("50");
  });

  it("persists an overrun and blocks the next reservation", async () => {
    harness.impl = async () => ({
      status: "success",
      ...liveCtx,
      attemptId: "att_overrun",
      costSource: "actual",
      draft: {
        title: "标题",
        content: "正文",
        tokensIn: 40000,
        tokensOut: 30000,
      },
    });

    await runTaskOnce();

    const [period] = await periodRows();
    expect(period.overrun).toBe(true);
    // 70 000 tokens * 0.8c/1k = 56c measured, on top of the seeded ¥1.80.
    expect(period.settledCents).toBeCloseTo(SEEDED_SETTLED_CENTS + 56, 5);

    const next = await reserveBudget({
      userId: DEMO_USER_ID,
      agentId: AGENT_ID,
      taskId: TASK_ID,
      timezone: TIMEZONE,
      amountCents: 1,
    });
    expect(next.allowed).toBe(false);
    expect(next.allowed === false && next.reason).toContain("超支");
  });

  it("keeps a prior week's bucket out of the current week total", async () => {
    const current = startOfLocalWeek(new Date(), TIMEZONE);
    const previousStart = new Date(current.getTime() - 7 * 86_400_000);
    await db.insert(agentBudgetPeriods).values({
      id: "bpd_previous_week",
      userId: DEMO_USER_ID,
      agentId: AGENT_ID,
      timezone: TIMEZONE,
      periodStart: previousStart,
      periodEnd: current,
      limitCents: 1200,
      settledCents: 12,
    });

    const usage = await loadWeeklyUsage(AGENT_ID, TIMEZONE);
    expect(usage.periodStart.getTime()).toBe(current.getTime());
    // Only the seeded current-week bucket counts; the previous week's 12 is not
    // rolled into this total.
    expect(usage.settledCents).toBe(SEEDED_SETTLED_CENTS);

    const [historical] = await db
      .select()
      .from(agentBudgetPeriods)
      .where(eq(agentBudgetPeriods.id, "bpd_previous_week"));
    expect(historical.settledCents).toBe(12);
  });

  it("does not open a second bucket when the timezone changes mid-week", async () => {
    const first = await loadWeeklyUsage(AGENT_ID, TIMEZONE);
    const second = await loadWeeklyUsage(AGENT_ID, "America/New_York");

    expect(second.periodId).toBe(first.periodId);
    expect(second.timezone).toBe(TIMEZONE);
    expect(await periodRows()).toHaveLength(1);
  });

  it("labels pre-ledger usage instead of reporting it as zero spend", async () => {
    // Simulate a week that predates the ledger: drop the seeded bucket so the
    // week holds runs with no ledger row, which is the legacy branch. The seeded
    // bucket itself is covered by the delta assertions in the tests above.
    await db.delete(agentBudgetPeriods).where(eq(agentBudgetPeriods.agentId, AGENT_ID));

    await db.insert(runs).values({
      id: "run_legacy_week",
      taskId: TASK_ID,
      agentId: AGENT_ID,
      status: "succeeded",
      mode: "live",
      sourceType: "system_event",
      costCents: 2.1,
      tokensIn: 100,
      tokensOut: 50,
    });

    const usage = await loadWeeklyUsage(AGENT_ID, TIMEZONE);
    expect(usage.legacyUnclassified).toBe(true);
    expect(usage.settledCents).toBe(0);

    const again = await loadWeeklyUsage(AGENT_ID, TIMEZONE);
    expect(again.periodId).toBe(usage.periodId);
  });

  it("keeps accounting even when no per-run cap is configured", async () => {
    // `maxRunCents: 0` used to skip `reserveBudget` entirely, so nothing was
    // ever settled and every later admission saw an empty period.
    const [cost] = await db
      .select()
      .from(policyConfig)
      .where(eq(policyConfig.key, "cost"));
    await db
      .update(policyConfig)
      .set({ valueJson: { ...(cost.valueJson as object), maxRunCents: 0 } })
      .where(eq(policyConfig.key, "cost"));

    harness.impl = async () => ({
      status: "success",
      ...liveCtx,
      attemptId: "att_uncapped",
      costSource: "actual",
      draft: { title: "标题", content: "正文", tokensIn: 500, tokensOut: 500 },
    });

    await runTaskOnce();

    const [reservation] = await reservationRows();
    expect(reservation.amountCents).toBe(0);
    expect(reservation.state).toBe("settled");
    expect(reservation.settledCents).toBeCloseTo(0.8, 5);

    const [period] = await periodRows();
    expect(period.reservedCents).toBe(0);
    // 1 000 tokens * 0.8c/1k measured, on top of the seeded ¥1.80.
    expect(period.settledCents).toBeCloseTo(SEEDED_SETTLED_CENTS + 0.8, 5);
  });

  it("applies a lowered Agent cap in the week it was lowered", async () => {
    await db
      .update(agents)
      .set({ budgetCents: 100 })
      .where(eq(agents.id, AGENT_ID));

    const usage = await loadWeeklyUsage(AGENT_ID, TIMEZONE);
    expect(usage.limitCents).toBe(100);

    // 100 - 180 already settled leaves nothing, so the next hold is refused
    // instead of silently using the 1200 the bucket was opened with.
    const denied = await reserveBudget({
      userId: DEMO_USER_ID,
      agentId: AGENT_ID,
      taskId: TASK_ID,
      timezone: TIMEZONE,
      amountCents: 50,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.allowed === false && denied.reason).toContain("0c");

    // Raising it back does not reopen the week: the stored snapshot is a floor.
    await db
      .update(agents)
      .set({ budgetCents: 9000 })
      .where(eq(agents.id, AGENT_ID));
    expect((await loadWeeklyUsage(AGENT_ID, TIMEZONE)).limitCents).toBe(1200);
  });

  it("counts a live run once in the local week of its user", async () => {
    harness.impl = async () => ({
      status: "success",
      ...liveCtx,
      attemptId: "att_week",
      costSource: "actual",
      draft: { title: "标题", content: "正文", tokensIn: 500, tokensOut: 500 },
    });

    await runTaskOnce();

    const usage = await loadWeeklyUsage(AGENT_ID, TIMEZONE);
    // 1 000 tokens * 0.8c/1k = 0.8c on top of the seeded ¥1.80.
    expect(usage.settledCents).toBeCloseTo(SEEDED_SETTLED_CENTS + 0.8, 5);

    const providerRuns = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.agentId, AGENT_ID),
          gte(runs.createdAt, usage.periodStart),
          isNotNull(runs.providerAttemptId),
        ),
      );
    expect(providerRuns).toHaveLength(1);
  });
});
