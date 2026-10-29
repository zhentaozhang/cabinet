import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agentBudgetReservations,
  agents,
  auditEvents,
  dissents,
  memories,
  runs,
  tasks,
} from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import {
  decideCouncil,
  evaluateDissents,
  runReflection,
} from "@/server/services/engine";
import { resetDb } from "../helpers/db";

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

beforeEach(async () => {
  await resetDb();
});

describe("formal dissent ledger", () => {
  it("records dissent when the user approves over opposition", async () => {
    const decided = await decideCouncil(
      "ccl_course",
      "approve",
      "批准试学，但保留退款提醒。",
      DEMO_USER_ID,
    );

    const rows = await db
      .select()
      .from(dissents)
      .where(
        and(
          eq(dissents.userId, DEMO_USER_ID),
          eq(dissents.councilId, "ccl_course"),
        ),
      );

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "pending")).toBe(true);
    expect(rows.every((row) => row.taskId === decided.resolution?.taskId)).toBe(
      true,
    );
    expect(rows.map((row) => row.condition.metric).sort()).toEqual([
      "audit_reject_count",
      "budget_spend_cents",
    ]);
  });

  it("vindicates a dissent when reality matches the warning, once", async () => {
    const [criticBefore] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_critic"));
    const [chiefBefore] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_chief"));

    await db
      .update(agents)
      .set({ status: "paused" })
      .where(eq(agents.id, "ag_critic"));
    await db.insert(auditEvents).values({
      id: "aud_pause_vindicate",
      userId: DEMO_USER_ID,
      actor: "user",
      action: "agent.update",
      target: "ag_critic",
      before: { status: "active" },
      after: { status: "paused" },
      hash: "test",
      prevHash: null,
      createdAt: daysAgo(3),
    });

    await db.insert(dissents).values({
      id: "dis_vindicate",
      userId: DEMO_USER_ID,
      councilId: "ccl_course",
      agentId: "ag_critic",
      warning: "强行推进会让一个 Agent 进入暂停。",
      condition: {
        metric: "agent_paused",
        operator: "==",
        threshold: 1,
        windowDays: 7,
      },
      status: "pending",
      evidence: [],
      createdAt: daysAgo(8),
    });

    const result = await evaluateDissents(DEMO_USER_ID);
    expect(result).toEqual({ vindicated: 1, invalidated: 0 });

    const [row] = await db
      .select()
      .from(dissents)
      .where(eq(dissents.id, "dis_vindicate"));
    expect(row.status).toBe("vindicated");
    expect(row.evaluatedAt).not.toBeNull();

    const [criticAfter] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_critic"));
    const [chiefAfter] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_chief"));
    expect(criticAfter.trustScore).toBe(
      Math.min(100, criticBefore.trustScore + 15),
    );
    expect(chiefAfter.trustScore).toBe(
      Math.max(0, chiefBefore.trustScore - 5),
    );

    const [precedent] = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, DEMO_USER_ID),
          eq(memories.type, "procedural"),
          eq(memories.sourceEventId, "dis_vindicate"),
          like(memories.factKey, "precedent:%"),
        ),
      );
    expect(precedent).toBeDefined();
    expect(precedent.content).toContain("判例");
    expect(precedent.value).toBe("vindicated:1");

    const auditRows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, DEMO_USER_ID),
          eq(auditEvents.target, "dis_vindicate"),
        ),
      );
    expect(auditRows.map((row) => row.action)).toContain("dissent.vindicated");

    const second = await evaluateDissents(DEMO_USER_ID);
    expect(second).toEqual({ vindicated: 0, invalidated: 0 });

    const [criticAgain] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_critic"));
    expect(criticAgain.trustScore).toBe(criticAfter.trustScore);
  });

  it("invalidates a dissent when the window closes without the warning happening", async () => {
    const [criticBefore] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_critic"));

    await db.insert(dissents).values({
      id: "dis_invalidate",
      userId: DEMO_USER_ID,
      councilId: "ccl_course",
      agentId: "ag_critic",
      warning: "审计驳回会超过 99 次。",
      condition: {
        metric: "audit_reject_count",
        operator: ">=",
        threshold: 99,
        windowDays: 7,
      },
      status: "pending",
      evidence: [],
      createdAt: daysAgo(8),
    });

    const result = await evaluateDissents(DEMO_USER_ID);
    expect(result).toEqual({ vindicated: 0, invalidated: 1 });

    const [row] = await db
      .select()
      .from(dissents)
      .where(eq(dissents.id, "dis_invalidate"));
    expect(row.status).toBe("invalidated");
    expect(row.evidence.some((item) => item.label === "复盘测量")).toBe(true);

    const [criticAfter] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_critic"));
    expect(criticAfter.trustScore).toBe(criticBefore.trustScore);
  });

  it("runs pending evaluations as part of reflection", async () => {
    await db
      .update(agents)
      .set({ status: "paused" })
      .where(eq(agents.id, "ag_critic"));
    await db.insert(auditEvents).values({
      id: "aud_pause_reflection",
      userId: DEMO_USER_ID,
      actor: "user",
      action: "agent.update",
      target: "ag_critic",
      before: { status: "active" },
      after: { status: "paused" },
      hash: "test",
      prevHash: null,
      createdAt: daysAgo(3),
    });
    await db.insert(dissents).values({
      id: "dis_reflection",
      userId: DEMO_USER_ID,
      councilId: "ccl_course",
      agentId: "ag_critic",
      warning: "暂停会发生。",
      condition: {
        metric: "agent_paused",
        operator: "==",
        threshold: 1,
        windowDays: 7,
      },
      status: "pending",
      evidence: [],
      createdAt: daysAgo(8),
    });

    await runReflection(DEMO_USER_ID);

    const [row] = await db
      .select()
      .from(dissents)
      .where(eq(dissents.id, "dis_reflection"));
    expect(row.status).toBe("vindicated");
  });

  it("does not attribute an unrelated rejection to a task-scoped dissent", async () => {
    await db.insert(dissents).values({
      id: "dis_scoped_reject",
      userId: DEMO_USER_ID,
      councilId: "ccl_course",
      taskId: "tsk_read",
      agentId: "ag_critic",
      warning: "这个阅读任务会被驳回。",
      condition: {
        metric: "audit_reject_count",
        operator: ">=",
        threshold: 1,
        windowDays: 7,
      },
      status: "pending",
      evidence: [],
      createdAt: daysAgo(8),
    });

    const result = await evaluateDissents(DEMO_USER_ID);
    expect(result).toEqual({ vindicated: 0, invalidated: 1 });

    const [row] = await db
      .select()
      .from(dissents)
      .where(eq(dissents.id, "dis_scoped_reject"));
    expect(row.status).toBe("invalidated");
  });

  it("does attribute an in-window rejection of the exact task", async () => {
    await db.insert(dissents).values({
      id: "dis_scoped_hit",
      userId: DEMO_USER_ID,
      councilId: "ccl_course",
      taskId: "tsk_arch_2",
      agentId: "ag_critic",
      warning: "这个任务会因引用缺失被驳回。",
      condition: {
        metric: "audit_reject_count",
        operator: ">=",
        threshold: 1,
        windowDays: 7,
      },
      status: "pending",
      evidence: [],
      createdAt: daysAgo(8),
    });

    const result = await evaluateDissents(DEMO_USER_ID);
    expect(result).toEqual({ vindicated: 1, invalidated: 0 });

    const [row] = await db
      .select()
      .from(dissents)
      .where(eq(dissents.id, "dis_scoped_hit"));
    expect(row.status).toBe("vindicated");
  });

  it("counts a failure by when it happened, not when the task was created", async () => {
    await db.insert(tasks).values({
      id: "tsk_failed_in_window",
      userId: DEMO_USER_ID,
      title: "失败发生在本周的任务",
      description: "创建于窗口之前，失败在窗口之内。",
      status: "failed",
      acceptanceCriteria: "有产物",
      estimateMin: 25,
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 0,
      createdBy: "agent",
      createdAt: daysAgo(20),
      updatedAt: daysAgo(3),
    });
    await db.insert(dissents).values({
      id: "dis_failure_window",
      userId: DEMO_USER_ID,
      councilId: "ccl_course",
      taskId: "tsk_failed_in_window",
      agentId: "ag_critic",
      warning: "这个任务会失败。",
      condition: {
        metric: "task_failure_count",
        operator: ">=",
        threshold: 1,
        windowDays: 7,
      },
      status: "pending",
      evidence: [],
      createdAt: daysAgo(8),
    });

    const result = await evaluateDissents(DEMO_USER_ID);
    expect(result).toEqual({ vindicated: 1, invalidated: 0 });
  });

  it("does not treat a historical pause as a new vindication", async () => {
    await db
      .update(agents)
      .set({ status: "paused" })
      .where(eq(agents.id, "ag_critic"));
    await db.insert(dissents).values({
      id: "dis_old_pause",
      userId: DEMO_USER_ID,
      councilId: "ccl_course",
      agentId: "ag_critic",
      warning: "会有一个 Agent 被暂停。",
      condition: {
        metric: "agent_paused",
        operator: ">=",
        threshold: 1,
        windowDays: 7,
      },
      status: "pending",
      evidence: [],
      createdAt: daysAgo(8),
    });

    const result = await evaluateDissents(DEMO_USER_ID);
    expect(result).toEqual({ vindicated: 0, invalidated: 1 });
  });

  it("measures a task-scoped budget dissent against the user's whole week", async () => {
    await db.insert(runs).values([
      {
        id: "run_budget_scope_1",
        taskId: "tsk_read",
        agentId: "ag_coach",
        status: "succeeded",
        costCents: 200,
        createdAt: daysAgo(3),
      },
      {
        id: "run_budget_scope_2",
        taskId: "tsk_exercise",
        agentId: "ag_coach",
        status: "succeeded",
        costCents: 150,
        createdAt: daysAgo(2),
      },
      {
        id: "run_budget_scope_old",
        taskId: "tsk_read",
        agentId: "ag_coach",
        status: "succeeded",
        costCents: 900,
        createdAt: daysAgo(30),
      },
    ]);
    await db.insert(dissents).values({
      id: "dis_budget_scope",
      userId: DEMO_USER_ID,
      councilId: "ccl_course",
      taskId: "tsk_read",
      agentId: "ag_treasurer",
      warning: "本周预算会超过 300 分。",
      condition: {
        metric: "budget_spend_cents",
        operator: ">=",
        threshold: 300,
        windowDays: 7,
      },
      status: "pending",
      evidence: [],
      createdAt: daysAgo(8),
    });

    const result = await evaluateDissents(DEMO_USER_ID);
    expect(result).toEqual({ vindicated: 1, invalidated: 0 });

    const [row] = await db
      .select()
      .from(dissents)
      .where(eq(dissents.id, "dis_budget_scope"));
    expect(row.status).toBe("vindicated");
    expect(
      row.evidence.some((item) => item.quote === "budget_spend_cents = 350"),
    ).toBe(true);
  });
  /**
   * 预算异议衡量的必须是台账认识的那笔钱。
   *
   * 超时 / 供应商报错 / 进程中断的调用「可能已经花了钱却没报用量」，run 上的
   * cost_cents 就是默认的 0；这份敞口只记在预算台账的 unknown_charged 行上。
   * 模型自己挑工具的那几次调用同样不写进任何 run，只在台账留下各自的 settled 行。
   * 只累加 runs.cost_cents 会把这两笔都当成没花钱——钱真的花掉、供应商没回话的
   * 那一周，反而把「预算会超」的警告判成没发生。
   */
  it("counts the spend the ledger recorded even when no run reported usage", async () => {
    await db.insert(runs).values([
      {
        id: "run_ledger_known",
        taskId: "tsk_read",
        agentId: "ag_coach",
        status: "succeeded",
        costCents: 200,
        createdAt: daysAgo(2),
      },
      {
        id: "run_ledger_unknown",
        taskId: "tsk_read",
        agentId: "ag_coach",
        status: "failed",
        costCents: 0,
        costSource: "unknown",
        createdAt: daysAgo(1),
      },
    ]);
    await db.insert(agentBudgetPeriods).values({
      id: "bpd_ledger",
      userId: DEMO_USER_ID,
      agentId: "ag_coach",
      timezone: "UTC",
      periodStart: daysAgo(7),
      periodEnd: daysAgo(0),
      limitCents: 5_000,
    });
    await db.insert(agentBudgetReservations).values([
      {
        id: "res_ledger_unknown",
        userId: DEMO_USER_ID,
        periodId: "bpd_ledger",
        agentId: "ag_coach",
        taskId: "tsk_read",
        runId: "run_ledger_unknown",
        state: "unknown_charged",
        amountCents: 400,
        createdAt: daysAgo(1),
      },
      {
        id: "res_ledger_tool",
        userId: DEMO_USER_ID,
        periodId: "bpd_ledger",
        agentId: "ag_coach",
        taskId: "tsk_read",
        runId: null,
        state: "settled",
        amountCents: 3,
        settledCents: 3,
        createdAt: daysAgo(1),
      },
      {
        id: "res_ledger_tool_old",
        userId: DEMO_USER_ID,
        periodId: "bpd_ledger",
        agentId: "ag_coach",
        taskId: "tsk_read",
        runId: null,
        state: "settled",
        amountCents: 5,
        settledCents: 5,
        createdAt: daysAgo(30),
      },
    ]);
    await db.insert(dissents).values({
      id: "dis_budget_ledger",
      userId: DEMO_USER_ID,
      councilId: "ccl_course",
      taskId: "tsk_read",
      agentId: "ag_treasurer",
      warning: "本周预算会超过 300 分。",
      condition: {
        metric: "budget_spend_cents",
        operator: ">=",
        threshold: 300,
        windowDays: 7,
      },
      status: "pending",
      evidence: [],
      createdAt: daysAgo(8),
    });

    const result = await evaluateDissents(DEMO_USER_ID);
    expect(result).toEqual({ vindicated: 1, invalidated: 0 });

    const [row] = await db
      .select()
      .from(dissents)
      .where(eq(dissents.id, "dis_budget_ledger"));
    expect(
      row.evidence.some((item) => item.quote === "budget_spend_cents = 603"),
    ).toBe(true);
  });
});

/**
 * 印证 dissent 时的信任分不能"读到旧值再写回去"。
 *
 * 复现方式是真并发：另一个事务先锁住 ag_critic 这一行并把它改成 57（模拟同一时刻
 * 审计路径刚提交了一次信任分自增），再让印证流程走完。不同连接、不同事务，没有 mock。
 * 读-改-写会把自己读到的 50 + 15 = 65 盖上去，把那次已提交的 +7 抹掉。
 */
async function waitForLockWaiter(timeoutMs = 5000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const rows = (await db.execute(
      sql`select count(*)::int as waiting from pg_locks where not granted`,
    )) as Array<{ waiting: number }>;
    if (Number(rows[0]?.waiting ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe("印证 dissent 与别的信任分写入并发", () => {
  it("adds the bonus on top of the score the other writer committed", async () => {
    await db
      .update(agents)
      .set({ status: "paused", trustScore: 50 })
      .where(eq(agents.id, "ag_critic"));
    await db.insert(dissents).values({
      id: "dis_race_vindicate",
      userId: DEMO_USER_ID,
      councilId: "ccl_course",
      agentId: "ag_critic",
      warning: "强行推进会让一个 Agent 进入暂停。",
      condition: {
        metric: "agent_paused",
        operator: "==",
        threshold: 1,
        windowDays: 7,
      },
      status: "pending",
      evidence: [],
      createdAt: daysAgo(8),
    });
    await db.insert(auditEvents).values({
      id: "aud_pause_race",
      userId: DEMO_USER_ID,
      actor: "user",
      action: "agent.update",
      target: "ag_critic",
      before: { status: "active" },
      after: { status: "paused" },
      hash: "test",
      prevHash: null,
      createdAt: daysAgo(3),
    });

    let locked!: () => void;
    let release!: () => void;
    const lockedPromise = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, "ag_critic"))
        .for("update");
      locked();
      await releasePromise;
      await tx
        .update(agents)
        .set({ trustScore: 57 })
        .where(eq(agents.id, "ag_critic"));
    });
    await lockedPromise;

    const pending = evaluateDissents(DEMO_USER_ID);
    const blocked = await waitForLockWaiter();
    release();
    await holder;
    const result = await pending;

    expect(blocked).toBe(true);
    expect(result).toEqual({ vindicated: 1, invalidated: 0 });

    const [criticAfter] = await db
      .select({ trustScore: agents.trustScore })
      .from(agents)
      .where(eq(agents.id, "ag_critic"));
    // 57 是另一个写入者已经提交的值；印证只该在它之上再加自己的 +15。
    expect(criticAfter.trustScore).toBe(72);
  });
});
