import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, lt } from "drizzle-orm";

const harness = vi.hoisted(() => ({
  impl: null as null | ((input: unknown) => Promise<unknown>),
  atCallTime: null as null | (() => Promise<void>),
}));

vi.mock("@/lib/llm", () => ({
  generateArtifact: async (input: unknown) => {
    if (harness.atCallTime) await harness.atCallTime();
    return harness.impl!(input);
  },
}));

import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agentBudgetReservations,
  artifacts,
  runs,
  steps,
} from "@/lib/db/schema";
import { RUN_COST_CENTS } from "@/lib/db/seed";
import { DEMO_USER_ID } from "@/lib/demo";
import { loadAgent } from "@/server/readmodels/agent";
import { loadCabinet } from "@/server/readmodels/cabinet";
import {
  budgetWeek,
  loadWeeklyUsage,
} from "@/server/services/commands/tasks/execution";
import { runTask } from "@/server/services/commands/tasks/run";
import { resetDb } from "../helpers/db";

const TASK_ID = "tsk_read";
const AGENT_ID = "ag_coach"; // seeded assignee, budget_cents 1200
const TIMEZONE = "Asia/Shanghai";
const liveCtx = { provider: "openai", model: "gpt-4.1-mini" };

/** The demo seed already settled this Agent's current-week run (¥1.80). */
const SEEDED_SETTLED_CENTS = RUN_COST_CENTS.quiz;

const measuredDraft = {
  title: "本周复盘",
  content: "正文",
  tokensIn: 111,
  tokensOut: 222,
};

beforeEach(async () => {
  await resetDb();
  harness.impl = null;
  harness.atCallTime = null;
});

afterEach(() => {
  delete process.env.DEMO_MODE;
});

describe("model usage accounting", () => {
  it("records only measured provider tokens and never the trace estimates", async () => {
    harness.impl = async () => ({
      status: "success",
      ...liveCtx,
      attemptId: "att_measured",
      costSource: "actual",
      draft: measuredDraft,
    });

    await runTask(TASK_ID, DEMO_USER_ID);

    const [run] = await db.select().from(runs).where(eq(runs.taskId, TASK_ID));
    expect(run.tokensIn).toBe(111);
    expect(run.tokensOut).toBe(222);
    expect(run.costCents).toBeCloseTo(0.27, 2);
    expect(run.costSource).toBe("actual");
    expect(run.provider).toBe("openai");
    expect(run.model).toBe("gpt-4.1-mini");

    // Deterministic context/plan/submit estimates stay on the step rows only,
    // so a display estimate can never inflate measured provider usage.
    const trace = await db.select().from(steps).where(eq(steps.runId, run.id));
    expect(trace.length).toBeGreaterThan(0);
    const traceTokens = trace.reduce((sum, s) => sum + s.tokensIn + s.tokensOut, 0);
    expect(traceTokens).toBeGreaterThan(0);
    expect(traceTokens).not.toBe(Number(run.tokensIn) + Number(run.tokensOut));

    const [period] = await db
      .select()
      .from(agentBudgetPeriods)
      .where(eq(agentBudgetPeriods.agentId, AGENT_ID));
    // 0.27 measured for this run, on top of the seeded ¥1.80.
    expect(period.settledCents).toBeCloseTo(SEEDED_SETTLED_CENTS + 0.27, 2);
    expect(period.unknownCents).toBe(0);
    expect(period.reservedCents).toBe(0);
  });

  it("lets a demo draft finish the workflow without claiming provider usage", async () => {
    process.env.DEMO_MODE = "true";
    harness.impl = async () => ({ status: "not_configured", attemptId: null });

    await runTask(TASK_ID, DEMO_USER_ID);

    const [run] = await db.select().from(runs).where(eq(runs.taskId, TASK_ID));
    expect(run.status).toBe("succeeded");
    expect(run.tokensIn).toBeNull();
    expect(run.tokensOut).toBeNull();
    expect(run.costSource).toBeNull();
    expect(run.providerAttemptId).toBeNull();

    const [artifact] = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.taskId, TASK_ID));
    expect(artifact.sourceType).toBe("demo_fixture");

    const usage = await loadWeeklyUsage(AGENT_ID, TIMEZONE);
    // The demo draft adds nothing: the seeded ¥1.80 is the whole settled total.
    expect(usage.settledCents).toBe(SEEDED_SETTLED_CENTS);
    expect(usage.unknownCents).toBe(0);
    expect(usage.reservedCents).toBe(0);
  });

  it("commits the reservation before any request leaves the process", async () => {
    let seen: { reserved: number; settled: number; holds: number } | null = null;
    harness.atCallTime = async () => {
      const usage = await loadWeeklyUsage(AGENT_ID, TIMEZONE);
      const holds = await db
        .select()
        .from(agentBudgetReservations)
        .where(eq(agentBudgetReservations.agentId, AGENT_ID));
      seen = {
        reserved: usage.reservedCents,
        settled: usage.settledCents,
        holds: holds.filter((h) => h.state === "reserved").length,
      };
    };
    harness.impl = async () => ({
      status: "success",
      ...liveCtx,
      attemptId: "att_preflight",
      costSource: "actual",
      draft: measuredDraft,
    });

    await runTask(TASK_ID, DEMO_USER_ID);

    // The hold is visible before the provider call, with the seeded ¥1.80 still
    // the only settled amount at that moment.
    expect(seen).toEqual({ reserved: 50, settled: SEEDED_SETTLED_CENTS, holds: 1 });
  });

  it("keeps the full reserve as exposure when usage is unknown", async () => {
    harness.impl = async () => ({
      status: "timeout",
      ...liveCtx,
      attemptId: "att_unknown",
      costSource: "unknown",
    });

    await expect(runTask(TASK_ID, DEMO_USER_ID)).rejects.toThrow(/timeout/);

    const usage = await loadWeeklyUsage(AGENT_ID, TIMEZONE);
    expect(usage.unknownCents).toBe(50);
    expect(usage.settledCents).toBe(SEEDED_SETTLED_CENTS); // no measured charge added
    expect(usage.reservedCents).toBe(0);
    expect(usage.overrun).toBe(false);
  });

  it("exposes the budget view separately from legacy spend columns", async () => {
    harness.impl = async () => ({
      status: "success",
      ...liveCtx,
      attemptId: "att_view",
      costSource: "actual",
      draft: measuredDraft,
    });
    await runTask(TASK_ID, DEMO_USER_ID);

    const page = await loadAgent(AGENT_ID, DEMO_USER_ID);
    expect(page).not.toBeNull();
    const budget = page!.budget;
    expect(budget.timezone).toBe(TIMEZONE);
    expect(budget.limitCents).toBe(1200);
    expect(budget.reservedCents).toBe(0);
    expect(budget.settledCents).toBeCloseTo(SEEDED_SETTLED_CENTS + 0.27, 2);
    expect(budget.unknownCents).toBe(0);
    expect(budget.overrun).toBe(false);
    expect(budget.legacyUnclassified).toBe(false);
    expect(budget.periodStart).toBeTruthy();
    expect(budget.periodEnd).toBeTruthy();
    // The frozen snapshot is not presented as current-week usage.
    expect(budget.limitCents).not.toBe(page!.agent.spentCents);
  });

  it("labels a week that predates the ledger instead of inventing spend", async () => {
    // Drop the seeded bucket for this Agent so its current week holds runs with
    // no ledger row — the legacy branch that predates the ledger.
    await db.delete(agentBudgetPeriods).where(eq(agentBudgetPeriods.agentId, AGENT_ID));

    const { periodStart } = budgetWeek(TIMEZONE);
    await db.insert(runs).values({
      id: "run_before_ledger",
      taskId: TASK_ID,
      agentId: AGENT_ID,
      status: "succeeded",
      mode: "live",
      sourceType: "model_generated",
      costCents: 2.1,
      tokensIn: 100,
      tokensOut: 50,
      createdAt: new Date(periodStart.getTime() + 1000),
    });

    const page = await loadAgent(AGENT_ID, DEMO_USER_ID);
    expect(page!.budget.legacyUnclassified).toBe(true);
    expect(page!.budget.settledCents).toBe(0);
    expect(page!.budget.unknownCents).toBe(0);
  });

  it("carries the budget into the cabinet cards", async () => {
    const page = await loadCabinet(DEMO_USER_ID);
    const budget = page.budgets[AGENT_ID];
    expect(budget).toBeDefined();
    expect(budget.limitCents).toBe(1200);
    // This is the seeded coach bucket for the current week: one settled ¥1.80
    // run, no unknown usage, and well under the ¥12 limit.
    expect(budget.settledCents).toBe(SEEDED_SETTLED_CENTS);
    expect(budget.unknownCents).toBe(0);
    for (const agent of page.agents) {
      expect(page.budgets[agent.id]).toBeDefined();
    }
  });

  it("does not count a settled amount twice across reads", async () => {
    harness.impl = async () => ({
      status: "success",
      ...liveCtx,
      attemptId: "att_idem",
      costSource: "actual",
      draft: measuredDraft,
    });
    await runTask(TASK_ID, DEMO_USER_ID);

    const first = await loadWeeklyUsage(AGENT_ID, TIMEZONE);
    const second = await loadWeeklyUsage(AGENT_ID, TIMEZONE);
    expect(second.settledCents).toBe(first.settledCents);
    const rows = await db
      .select()
      .from(agentBudgetReservations)
      .where(eq(agentBudgetReservations.agentId, AGENT_ID));
    expect(rows.filter((r) => r.state === "settled")).toHaveLength(1);
    expect(rows.every((r) => r.settledCents >= 0)).toBe(true);
    expect(await db.select().from(agentBudgetPeriods).where(lt(agentBudgetPeriods.limitCents, 0))).toHaveLength(0);
  });
});
