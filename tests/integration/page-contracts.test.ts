import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { agentBudgetPeriods, agents, tasks, users } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import {
  getWeeklyMetrics,
  getWeeklySpendByAgent,
} from "@/server/services/queries/metrics";
import {
  loadAgent,
  loadCabinet,
  loadCouncil,
  loadMemory,
  loadReview,
  loadTask,
  loadToday,
} from "@/server/readmodels";
import { getPolicyConfigFor } from "@/lib/policy/config";
import { upgradeRequirementsLine } from "@/lib/presentation/cabinet-view";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("page DTO contracts", () => {
  it("passes every seeded page through its runtime DTO", async () => {
    await expect(loadToday(DEMO_USER_ID)).resolves.toBeTruthy();
    await expect(loadReview(DEMO_USER_ID)).resolves.toBeTruthy();
    await expect(loadCabinet(DEMO_USER_ID)).resolves.toBeTruthy();
    await expect(loadCouncil(DEMO_USER_ID)).resolves.toBeTruthy();
    await expect(loadMemory(DEMO_USER_ID)).resolves.toBeTruthy();
    await expect(loadTask("tsk_read", DEMO_USER_ID)).resolves.toBeTruthy();
    await expect(loadAgent("ag_coach", DEMO_USER_ID)).resolves.toBeTruthy();
  });
});

/**
 * Agent 详情页的授权控制卡下面写着「升级需要：…」。那行字原来是一份写死的
 * 副本（信任分 ≥70 · 成功任务 ≥3 · 有效审计样本 ≥5 · 非试用期），漏了
 * decideUpgrade 的最后一道闸：审计通过率 ≥ config.autonomy.minAuditPassRate。
 * 现在门槛走页面 DTO，这里钉住它和真正判升级用的配置是同一份值。
 */
describe("the agent page prints the upgrade floors the runtime enforces", () => {
  it("carries every threshold decideUpgrade checks", async () => {
    const config = await getPolicyConfigFor(DEMO_USER_ID);
    const page = await loadAgent("ag_coach", DEMO_USER_ID);
    expect(page?.policy.autonomy).toEqual({
      minTrust: config.autonomy.minTrust,
      minSuccesses: config.autonomy.minSuccesses,
      minAuditSamples: config.autonomy.minAuditSamples,
      minAuditPassRate: config.autonomy.minAuditPassRate,
    });
    expect(
      upgradeRequirementsLine(page!.policy.autonomy),
    ).toContain("审计通过率 ≥90%");
  });
});

/**
 * Today is the page that has to answer "what went wrong". A failed task was
 * filtered out of the read model entirely, so the one state that most needs a
 * human decision was the only one the page could never show.
 *
 * The tenancy half of this test is a regression guard, not decoration: widening
 * a `status` filter is exactly the kind of change that drops a `userId` scope.
 */
describe("Today's read model carries failed tasks", () => {
  const OTHER_USER_ID = "usr_today_failed_other";

  async function seedFailedTask(input: {
    id: string;
    userId: string;
    title: string;
  }) {
    await db.insert(tasks).values({
      id: input.id,
      userId: input.userId,
      title: input.title,
      description: "执行失败，等待用户判断是否重试。",
      status: "failed",
      acceptanceCriteria: "有产物",
      estimateMin: 25,
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 0,
      createdBy: "agent",
      dueAt: new Date("2030-01-01T21:00:00.000Z"),
    });
  }

  it("includes the demo user's failed task and excludes another user's", async () => {
    await db.insert(users).values({
      id: OTHER_USER_ID,
      email: "today-failed-other@cabinet.local",
      name: "Other",
      emailVerified: true,
      timezone: "Asia/Shanghai",
      updatedAt: new Date(),
    });
    await seedFailedTask({
      id: "tsk_failed_demo",
      userId: DEMO_USER_ID,
      title: "抓取失败：课程页面超时",
    });
    await seedFailedTask({
      id: "tsk_failed_other",
      userId: OTHER_USER_ID,
      title: "另一个租户的失败任务",
    });

    const today = await loadToday(DEMO_USER_ID);
    const ids = today.tasks.map((task) => task.id);

    // Inclusion: the bug this fixes. Failed work is still work waiting on you.
    expect(ids).toContain("tsk_failed_demo");
    // Tenancy: a widened status filter must never widen the user scope.
    expect(ids).not.toContain("tsk_failed_other");

    // The failed task survives the existing task DTO unchanged.
    const failed = today.tasks.find((task) => task.id === "tsk_failed_demo");
    expect(failed?.status).toBe("failed");
    expect(failed?.userId).toBe(DEMO_USER_ID);
  });
});
/**
 * The spend card used to read two sources as one fact: the weekly total came
 * from the budget ledger while "top spender" came from `agents.spentCents`, a
 * frozen legacy column nothing writes at runtime. The card could therefore show
 * "no cost yet" next to a stale number, or a spender who never spent.
 *
 * The only thing that keeps them consistent is that both read the same rows, so
 * the assertion is literally "the parts sum to the whole" against a real ledger.
 */
describe("the Today spend card has one source of truth", () => {
  async function seedPeriod(input: {
    id: string;
    userId: string;
    agentId?: string;
    settledCents: number;
    unknownCents: number;
    offsetMs?: number;
  }) {
    const start = new Date(Date.now() + (input.offsetMs ?? 0));
    await db.insert(agentBudgetPeriods).values({
      id: input.id,
      userId: input.userId,
      // ag_auditor carries no seeded period, so the unique
      // (agent_id, period_start) key cannot collide with the demo data.
      agentId: input.agentId ?? "ag_auditor",
      timezone: "Asia/Shanghai",
      periodStart: start,
      periodEnd: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000),
      limitCents: 500000,
      reservedCents: 0,
      settledCents: input.settledCents,
      unknownCents: input.unknownCents,
    });
  }

  it("sums exactly the ledger rows the weekly total is made of", async () => {
    await seedPeriod({
      id: "abp_today_spend_demo",
      userId: DEMO_USER_ID,
      settledCents: 900,
      unknownCents: 100,
    });

    const byAgent = await getWeeklySpendByAgent(DEMO_USER_ID);
    const weekly = await getWeeklyMetrics(DEMO_USER_ID);
    const today = await loadToday(DEMO_USER_ID);

    const sum = byAgent.reduce((total, row) => total + row.cents, 0);
    expect(sum).toBe(weekly.costCents);
    // The page's number and this ledger total are the same number.
    expect(today.weeklyMetrics.costCents).toBe(weekly.costCents);

    // Descending, so the first row is the top spender by construction.
    const cents = byAgent.map((row) => row.cents);
    expect(cents).toEqual([...cents].sort((a, b) => b - a));

    // 900 + 100 beats the seeded research run (340).
    expect(today.topSpender?.agentId).toBe("ag_auditor");
    expect(today.topSpender?.cents).toBe(1000);
    expect(today.topSpender?.name).toBeTruthy();
  });

  it("never counts another tenant's ledger rows", async () => {
    // Baseline first: the assertion has to be "the other tenant changed
    // nothing", not "this id is absent" — the latter is vacuously true for a
    // reader who happens to own no ledger rows at all.
    const before = await getWeeklySpendByAgent(DEMO_USER_ID);
    const beforeWeekly = await getWeeklyMetrics(DEMO_USER_ID);
    const beforeSum = before.reduce((total, row) => total + row.cents, 0);
    expect(beforeSum).toBe(beforeWeekly.costCents);

    const otherUserId = "usr_today_spend_other";
    await db.insert(users).values({
      id: otherUserId,
      email: "today-spend-other@cabinet.local",
      name: "Other",
      emailVerified: true,
      timezone: "Asia/Shanghai",
      updatedAt: new Date(),
    });
    // An agent of that tenant, so the row is reachable only through the other
    // user's scope. Pointing the period at a demo agent would make the row
    // itself contradictory and the test would prove nothing.
    await db.insert(agents).values({
      id: "ag_other_tenant",
      userId: otherUserId,
      role: "auditor",
      name: "别的租户的审计官",
      title: "Auditor",
      avatar: "审",
      charter: "只审计另一个租户的工作。",
      objective: "不属于当前读者。",
      tools: [],
      memoryScope: [],
    });
    await seedPeriod({
      id: "abp_today_spend_other",
      userId: otherUserId,
      agentId: "ag_other_tenant",
      settledCents: 99999,
      unknownCents: 0,
      offsetMs: 60 * 60 * 1000,
    });

    const byAgent = await getWeeklySpendByAgent(DEMO_USER_ID);
    const weekly = await getWeeklyMetrics(DEMO_USER_ID);
    const sum = byAgent.reduce((total, row) => total + row.cents, 0);

    expect(sum).toBe(weekly.costCents);
    // Both halves of the tenant boundary: no new spender, no new money.
    expect(byAgent.map((row) => row.agentId)).not.toContain("ag_other_tenant");
    expect(byAgent).toEqual(before);
    expect(weekly.costCents).toBe(beforeWeekly.costCents);
  });
});