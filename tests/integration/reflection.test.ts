import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agents,
  checkins,
  insights,
  memories,
  tasks,
  users,
} from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import {
  addLocalDays,
  localDateKey,
  localDateTimeParts,
  startOfLocalWeek,
  zonedTimeToUtc,
} from "@/lib/domain/time";
import { retrieveMemories } from "@/lib/memory/retrieval";
import { decayMemoryScores } from "@/lib/memory/decay";
import { writeMemoryFact } from "@/server/services/commands/memory/facts";
import {
  applyInsight,
  getMemoryData,
  runReflection,
} from "@/server/services/engine";
import { setupWorkspace } from "@/lib/setup";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("real reflection", () => {
  it("turns a real audit rejection into an evidence-backed insight", async () => {
    const insight = await runReflection(DEMO_USER_ID);
    expect(insight).not.toBeNull();
    expect(insight!.claim).not.toContain("把 21:00 的阅读任务移到 13:30");
    expect(insight!.evidence.length).toBeGreaterThan(0);
    expect(insight!.evidence.every((item) => Boolean(item.ref))).toBe(true);
    expect(insight!.evidence[0].ref).toBe("audit:aud_seed_6");
    expect(insight!.proposedChange.type).toBe("add_rule");
  });

  it("does not repeat the same claim, and falls through to the next signal", async () => {
    const first = await runReflection(DEMO_USER_ID);
    const second = await runReflection(DEMO_USER_ID);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.claim).not.toBe(first!.claim);

    const third = await runReflection(DEMO_USER_ID);
    expect(third).toBeNull();
  });

  it("returns null when there is no signal at all", async () => {
    await db.insert(users).values({
      id: "usr_empty",
      email: "empty@cabinet.local",
      name: "Empty",
      emailVerified: true,
      timezone: "Asia/Shanghai",
      updatedAt: new Date(),
    });

    expect(await runReflection("usr_empty")).toBeNull();
  });

  it("does not treat cumulative spend as this week's budget", async () => {
    const userId = "usr_budget_test";
    await db.insert(users).values({
      id: userId,
      email: "budget-test@cabinet.local",
      name: "Budget Test",
      emailVerified: true,
      timezone: "Asia/Shanghai",
      updatedAt: new Date(),
    });
    await setupWorkspace({ userId, timezone: "Asia/Shanghai" });
    await db
      .update(agents)
      .set({ spentCents: 60_000 })
      .where(eq(agents.userId, userId));

    expect(await runReflection(userId)).toBeNull();
  });

  /**
   * 周预算的额度是按 Agent 分桶的：每个桶的 limit 是 min(该 Agent 预算, 策略默认
   * 上限)。所以工作区一周能花的是各桶之和，不存在「工作区总上限」。下面两个用例
   * 钉住这一点——原来「各 Agent 花费之和 ÷ 单个 Agent 上限」的算法会把每个 Agent
   * 都在额度内的正常工作区读成超支（40000×7 分 ÷ 60000 = 466%）。
   */
  async function seedBudgetBuckets(
    userId: string,
    spendByRole: Record<string, number>,
  ): Promise<{ id: string; name: string; role: string }[]> {
    const timezone = "Asia/Shanghai";
    const periodStart = startOfLocalWeek(new Date(), timezone);
    const periodEnd = addLocalDays(periodStart, 7, timezone);
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.userId, userId));
    for (const agent of rows) {
      await db.insert(agentBudgetPeriods).values({
        id: `bpd_${agent.id}_${periodStart.getTime()}`,
        userId,
        agentId: agent.id,
        timezone,
        periodStart,
        periodEnd,
        limitCents: 60_000,
        settledCents: spendByRole[agent.role] ?? 0,
      });
    }
    return rows.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
    }));
  }

  async function seedBudgetWorkspace(userId: string): Promise<void> {
    await db.insert(users).values({
      id: userId,
      email: `${userId}@cabinet.local`,
      name: "Budget Workspace",
      emailVerified: true,
      timezone: "Asia/Shanghai",
      updatedAt: new Date(),
    });
    await setupWorkspace({ userId, timezone: "Asia/Shanghai" });
    // budgetCents = 0 表示「听策略的」，于是每个 Agent 的额度都是策略默认上限。
    await db.update(agents).set({ budgetCents: 0 }).where(eq(agents.userId, userId));
  }

  it("measures budget pressure per Agent, not against one ceiling for the workspace", async () => {
    const userId = "usr_budget_buckets";
    await seedBudgetWorkspace(userId);
    await seedBudgetBuckets(userId, {
      chief: 40_000,
      researcher: 40_000,
      coach: 40_000,
      treasurer: 40_000,
      auditor: 40_000,
      apprentice: 40_000,
      critic: 40_000,
    });

    // 每个 Agent 用了自己 60000 额度的 67%，全工作区 280000/420000 = 67%：没有压力。
    expect(await runReflection(userId)).toBeNull();
  });

  it("names the Agent that is actually close to its cap", async () => {
    const userId = "usr_budget_tight";
    await seedBudgetWorkspace(userId);
    const agentsRows = await seedBudgetBuckets(userId, { coach: 54_000 });
    const tight = agentsRows.find((agent) => agent.role === "coach");
    if (!tight) throw new Error("coach missing");

    const insight = await runReflection(userId);
    expect(insight).not.toBeNull();
    expect(insight!.claim).toContain(tight.name);
    expect(insight!.claim).toContain("90%");
    expect(insight!.claim).toContain("54000/60000");
    expect(insight!.rationale).toContain("额度");
    expect(insight!.evidence[0].ref).toBe(`agent:${tight.id}`);
  });
  it("uses low energy check-ins as a real signal", async () => {
    await db.insert(checkins).values({
      id: "chk_low",
      userId: DEMO_USER_ID,
      // Derived, not hardcoded: a fixed date collides with the seeded
      // "yesterday" row as soon as the wall clock crosses a day boundary.
      date: localDateKey(addLocalDays(new Date(), -3, "Asia/Shanghai"), "Asia/Shanghai"),
      energy: 1,
      mood: 2,
      completed: [],
      note: "完全没力气",
      createdAt: new Date(),
    });

    const first = await runReflection(DEMO_USER_ID);
    const second = await runReflection(DEMO_USER_ID);
    const third = await runReflection(DEMO_USER_ID);
    expect(first!.claim).toContain("审计驳回");
    expect(second!.claim).toContain("晚间");
    expect(third!.claim).toContain("精力只有 1/5");
  });

  it("does not count a cancelled evening task as one that was not finished", async () => {
    // The evening signal is "you keep scheduling work at night and not finishing",
    // so the denominator is evening tasks that are still owed. A task the user
    // withdrew on purpose is neither finished nor owed: leaving it in the count
    // keeps the completion rate below the threshold forever.
    const tz = "Asia/Shanghai";
    const yesterday = localDateTimeParts(addLocalDays(new Date(), -1, tz), tz);
    await db.insert(tasks).values({
      id: "tsk_evening_cancelled",
      userId: DEMO_USER_ID,
      title: "取消掉的晚间复习",
      description: "原本排在 21:00，用户主动撤回。",
      acceptanceCriteria: "写三行笔记，至少一个自己的例子。",
      assigneeId: "ag_coach",
      auditorId: "ag_auditor",
      status: "cancelled",
      dueAt: zonedTimeToUtc(yesterday.year, yesterday.month, yesterday.day, 21, 0, tz),
      createdBy: "user",
      createdAt: new Date(),
    });

    const first = await runReflection(DEMO_USER_ID);
    const second = await runReflection(DEMO_USER_ID);
    expect(first!.claim).toContain("审计驳回");
    expect(second!.claim).toContain("安排了 2 个任务");
    expect(second!.claim).not.toContain("安排了 3 个任务");
  });

  it("does not count an evening task that is not due until tomorrow", async () => {
    // 「过去 7 天内」不包括还没到点的事：把明天 21:00 的任务算进分母，等于
    // 因为用户「排了」就宣布他「没做完」——这条洞察会在任务被排到未来时凭空触发。
    const tz = "Asia/Shanghai";
    const tomorrow = localDateTimeParts(addLocalDays(new Date(), 1, tz), tz);
    await db.insert(tasks).values({
      id: "tsk_evening_tomorrow",
      userId: DEMO_USER_ID,
      title: "明天晚上的阅读",
      description: "排在明天 21:00，现在还没到该做完的时候。",
      acceptanceCriteria: "读完写三行笔记，至少一个自己的例子。",
      assigneeId: "ag_coach",
      auditorId: "ag_auditor",
      status: "planned",
      dueAt: zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, 21, 0, tz),
      createdBy: "user",
      createdAt: new Date(),
    });

    const first = await runReflection(DEMO_USER_ID);
    const second = await runReflection(DEMO_USER_ID);
    expect(first!.claim).toContain("审计驳回");
    expect(second!.claim).toContain("安排了 2 个任务");
    expect(second!.claim).not.toContain("安排了 3 个任务");
  });

  it("keeps an older task that is still inside the window", async () => {
    // 原来是先取「最近创建的 200 条」再在 JS 里按窗口过滤：任务一多，更早创建、
    // 截止时间还在窗口内的晚间任务会先被截断掉，分母少一条而结论照旧打印。
    const tz = "Asia/Shanghai";
    const yesterday = localDateTimeParts(addLocalDays(new Date(), -1, tz), tz);
    const fillerCreatedAt = addLocalDays(new Date(), -41, tz);
    await db.insert(tasks).values(
      Array.from({ length: 200 }, (_, index) => ({
        id: `tsk_reflection_filler_${index}`,
        userId: DEMO_USER_ID,
        title: `已完成的旧任务 ${index}`,
        description: "只用来把「最近 200 条」填满，不参与晚间统计。",
        acceptanceCriteria: "早已验收，与本条洞察无关。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        status: "done" as const,
        dueAt: null,
        createdBy: "user" as const,
        createdAt: fillerCreatedAt,
      })),
    );
    const olderCreatedAt = addLocalDays(new Date(), -42, tz);
    await db.insert(tasks).values(
      ["甲", "乙"].map((label) => ({
        id: `tsk_evening_old_${label}`,
        userId: DEMO_USER_ID,
        title: `更早安排、昨晚才该做完的晚间任务${label}`,
        description: "创建得比那 200 条都早，但截止时间就在昨晚 21:00。",
        acceptanceCriteria: "写三行笔记，不抄原文。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        status: "planned" as const,
        dueAt: zonedTimeToUtc(
          yesterday.year,
          yesterday.month,
          yesterday.day,
          21,
          0,
          tz,
        ),
        createdBy: "user" as const,
        createdAt: olderCreatedAt,
      })),
    );

    const first = await runReflection(DEMO_USER_ID);
    const second = await runReflection(DEMO_USER_ID);
    expect(first!.claim).toContain("审计驳回");
    // 种子自带 2 个已到点的晚间任务，这两条更早创建的也必须算进来。
    expect(second!.claim).toContain("安排了 4 个任务");
  });
});

describe("bi-temporal memory", () => {
  it("supersedes an old fact instead of silently overwriting it", async () => {
    const [first] = await db
      .insert(insights)
      .values({
        id: "ins_fact_1",
        userId: DEMO_USER_ID,
        claim: "把阅读移到 09:00。",
        rationale: "测试第一版事实。",
        confidence: 0.8,
        evidence: [{ label: "任务", ref: "task:tsk_read" }],
        proposedChange: {
          type: "reschedule",
          taskId: "tsk_read",
          from: "21:00",
          to: "09:00",
        },
        status: "proposed",
      })
      .returning();

    await applyInsight(first.id, "accept", DEMO_USER_ID);

    const [second] = await db
      .insert(insights)
      .values({
        id: "ins_fact_2",
        userId: DEMO_USER_ID,
        claim: "把阅读移到 10:00。",
        rationale: "测试第二版事实。",
        confidence: 0.8,
        evidence: [{ label: "任务", ref: "task:tsk_read" }],
        proposedChange: {
          type: "reschedule",
          taskId: "tsk_read",
          from: "09:00",
          to: "10:00",
        },
        status: "proposed",
      })
      .returning();

    await applyInsight(second.id, "accept", DEMO_USER_ID);

    const facts = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, DEMO_USER_ID),
          eq(memories.factKey, "schedule:tsk_read"),
        ),
      )
      .orderBy(memories.validFrom);

    expect(facts).toHaveLength(2);
    const oldFact = facts.find((fact) => fact.value === "09:00");
    const newFact = facts.find((fact) => fact.value === "10:00");
    expect(oldFact?.validTo).not.toBeNull();
    expect(oldFact?.status).toBe("superseded");
    expect(oldFact?.supersededBy).toBe(newFact?.id);
    expect(newFact?.validTo).toBeNull();

    const current = await getMemoryData(DEMO_USER_ID, undefined, "current");
    const history = await getMemoryData(DEMO_USER_ID, undefined, "history");
    expect(current.memories.some((memory) => memory.id === oldFact?.id)).toBe(
      false,
    );
    expect(history.memories.some((memory) => memory.id === oldFact?.id)).toBe(
      true,
    );

    const retrieved = await retrieveMemories(DEMO_USER_ID, "阅读", {
      limit: 50,
    });
    expect(retrieved.some((memory) => memory.id === oldFact?.id)).toBe(false);
    expect(retrieved.some((memory) => memory.id === newFact?.id)).toBe(true);
  });

  it("does not supersede when the fact value is confirmed again", async () => {
    const [first] = await db
      .insert(insights)
      .values({
        id: "ins_same_1",
        userId: DEMO_USER_ID,
        claim: "阅读固定在 09:00。",
        rationale: "第一次确认。",
        confidence: 0.8,
        evidence: [{ label: "任务", ref: "task:tsk_read" }],
        proposedChange: {
          type: "reschedule",
          taskId: "tsk_read",
          from: "21:00",
          to: "09:00",
        },
        status: "proposed",
      })
      .returning();
    await applyInsight(first.id, "accept", DEMO_USER_ID);

    const [second] = await db
      .insert(insights)
      .values({
        id: "ins_same_2",
        userId: DEMO_USER_ID,
        claim: "再次确认阅读固定在 09:00。",
        rationale: "第二次确认。",
        confidence: 0.8,
        evidence: [{ label: "任务", ref: "task:tsk_read" }],
        proposedChange: {
          type: "reschedule",
          taskId: "tsk_read",
          from: "08:00",
          to: "09:00",
        },
        status: "proposed",
      })
      .returning();
    await applyInsight(second.id, "accept", DEMO_USER_ID);

    const facts = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, DEMO_USER_ID),
          eq(memories.factKey, "schedule:tsk_read"),
        ),
      );
    expect(facts).toHaveLength(1);
    expect(facts[0].validTo).toBeNull();
    expect(facts[0].lastConfirmedAt).not.toBeNull();

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_read"));
    expect(task.dueAt).not.toBeNull();
  });

  it("restores the previous fact when the newer insight is rolled back", async () => {
    const [first] = await db
      .insert(insights)
      .values({
        id: "ins_restore_1",
        userId: DEMO_USER_ID,
        claim: "把阅读移到 09:00。",
        rationale: "第一版事实。",
        confidence: 0.8,
        evidence: [{ label: "任务", ref: "task:tsk_read" }],
        proposedChange: {
          type: "reschedule",
          taskId: "tsk_read",
          from: "21:00",
          to: "09:00",
        },
        status: "proposed",
      })
      .returning();
    await applyInsight(first.id, "accept", DEMO_USER_ID);

    const [second] = await db
      .insert(insights)
      .values({
        id: "ins_restore_2",
        userId: DEMO_USER_ID,
        claim: "把阅读移到 10:00。",
        rationale: "第二版事实。",
        confidence: 0.8,
        evidence: [{ label: "任务", ref: "task:tsk_read" }],
        proposedChange: {
          type: "reschedule",
          taskId: "tsk_read",
          from: "09:00",
          to: "10:00",
        },
        status: "proposed",
      })
      .returning();
    await applyInsight(second.id, "accept", DEMO_USER_ID);

    await applyInsight(second.id, "rollback", DEMO_USER_ID);

    const facts = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, DEMO_USER_ID),
          eq(memories.factKey, "schedule:tsk_read"),
        ),
      )
      .orderBy(memories.validFrom);
    const oldFact = facts.find((fact) => fact.value === "09:00");
    const newFact = facts.find((fact) => fact.value === "10:00");

    expect(newFact?.status).toBe("rolled_back");
    expect(newFact?.validTo).not.toBeNull();
    expect(oldFact?.status).toBe("active");
    expect(oldFact?.validTo).toBeNull();
    expect(oldFact?.supersededBy).toBeNull();

    const retrieved = await retrieveMemories(DEMO_USER_ID, "阅读", {
      limit: 100,
    });
    expect(retrieved.some((memory) => memory.id === oldFact?.id)).toBe(true);
    expect(retrieved.some((memory) => memory.id === newFact?.id)).toBe(false);
  });
});

describe("fact conflict rule", () => {
  it("keeps the active fact and records a low-confidence auto write as conflicted", async () => {
    const factKey = "schedule:test_conflict_low";
    await db.transaction(async (tx) => {
      await writeMemoryFact(tx, {
        userId: DEMO_USER_ID,
        agentId: "ag_coach",
        type: "semantic",
        domain: "learning",
        content: "阅读固定在 09:00。",
        confidence: 0.9,
        salience: 0.7,
        evidence: [],
        sourceEventId: "evt_conflict_old",
        factKey,
        value: "09:00",
      });
      await writeMemoryFact(tx, {
        userId: DEMO_USER_ID,
        agentId: "ag_coach",
        type: "semantic",
        domain: "learning",
        content: "自动推测阅读改到 10:00。",
        confidence: 0.4,
        salience: 0.7,
        evidence: [],
        sourceEventId: "evt_conflict_new",
        factKey,
        value: "10:00",
      });
    });

    const facts = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, DEMO_USER_ID),
          eq(memories.factKey, factKey),
        ),
      );
    expect(facts).toHaveLength(2);

    const active = facts.filter((fact) => fact.validTo === null);
    const conflicted = facts.find((fact) => fact.status === "conflicted");
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("09:00");
    expect(conflicted?.value).toBe("10:00");
    expect(conflicted?.validTo).not.toBeNull();
  });

  it("lets a high-confidence auto write supersede a weaker active fact", async () => {
    const factKey = "schedule:test_conflict_high";
    await db.transaction(async (tx) => {
      await writeMemoryFact(tx, {
        userId: DEMO_USER_ID,
        agentId: "ag_coach",
        type: "semantic",
        domain: "learning",
        content: "阅读固定在 09:00。",
        confidence: 0.55,
        salience: 0.7,
        evidence: [],
        sourceEventId: "evt_high_old",
        factKey,
        value: "09:00",
      });
      await writeMemoryFact(tx, {
        userId: DEMO_USER_ID,
        agentId: "ag_coach",
        type: "semantic",
        domain: "learning",
        content: "高置信证据表明阅读改到 10:00。",
        confidence: 0.9,
        salience: 0.7,
        evidence: [],
        sourceEventId: "evt_high_new",
        factKey,
        value: "10:00",
      });
    });

    const facts = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, DEMO_USER_ID),
          eq(memories.factKey, factKey),
        ),
      );
    const active = facts.filter((fact) => fact.validTo === null);
    const superseded = facts.find((fact) => fact.status === "superseded");
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("10:00");
    expect(superseded?.value).toBe("09:00");
  });
});

describe("memory scope", () => {
  it("shows the agent's own memories and in-scope user-level memories only", async () => {
    await db.insert(memories).values([
      {
        id: "mem_scope_own",
        userId: DEMO_USER_ID,
        agentId: "ag_coach",
        type: "semantic",
        domain: "budget",
        content: "scopecheck 教练自己的私有记忆。",
        confidence: 0.8,
        salience: 0.8,
        evidence: [],
      },
      {
        id: "mem_scope_other_agent",
        userId: DEMO_USER_ID,
        agentId: "ag_treasurer",
        type: "semantic",
        domain: "learning",
        content: "scopecheck 财务的私有记忆。",
        confidence: 0.8,
        salience: 0.8,
        evidence: [],
      },
      {
        id: "mem_scope_user_learning",
        userId: DEMO_USER_ID,
        agentId: null,
        type: "semantic",
        domain: "learning",
        content: "scopecheck 用户级学习记忆。",
        confidence: 0.8,
        salience: 0.8,
        evidence: [],
      },
      {
        id: "mem_scope_user_budget",
        userId: DEMO_USER_ID,
        agentId: null,
        type: "semantic",
        domain: "budget",
        content: "scopecheck 用户级预算记忆。",
        confidence: 0.8,
        salience: 0.8,
        evidence: [],
      },
      {
        id: "mem_scope_user_health",
        userId: DEMO_USER_ID,
        agentId: null,
        type: "semantic",
        domain: "health",
        content: "scopecheck 用户级健康记忆。",
        confidence: 0.8,
        salience: 0.8,
        evidence: [],
      },
    ]);

    const coach = await retrieveMemories(DEMO_USER_ID, "scopecheck", {
      limit: 100,
      agentId: "ag_coach",
      scopes: ["learning"],
    });
    const coachIds = coach.map((memory) => memory.id);
    expect(coachIds).toContain("mem_scope_own");
    expect(coachIds).toContain("mem_scope_user_learning");
    expect(coachIds).not.toContain("mem_scope_other_agent");
    expect(coachIds).not.toContain("mem_scope_user_budget");
    expect(coachIds).not.toContain("mem_scope_user_health");

    const treasurer = await retrieveMemories(DEMO_USER_ID, "scopecheck", {
      limit: 100,
      agentId: "ag_treasurer",
      scopes: ["budget"],
    });
    const treasurerIds = treasurer.map((memory) => memory.id);
    expect(treasurerIds).toContain("mem_scope_other_agent");
    expect(treasurerIds).toContain("mem_scope_user_budget");
    expect(treasurerIds).not.toContain("mem_scope_own");
    expect(treasurerIds).not.toContain("mem_scope_user_learning");
    expect(treasurerIds).not.toContain("mem_scope_user_health");
  });

  it("does not scope-filter when no agent is given", async () => {
    await db.insert(memories).values([
      {
        id: "mem_scope_unfiltered",
        userId: DEMO_USER_ID,
        agentId: null,
        type: "semantic",
        domain: "unscoped",
        content: "scopecheck 无范围过滤记忆。",
        confidence: 0.8,
        salience: 0.8,
        evidence: [],
      },
      {
        id: "mem_scope_unfiltered_private",
        userId: DEMO_USER_ID,
        agentId: "ag_treasurer",
        type: "semantic",
        domain: "budget",
        content: "scopecheck 未过滤时的私有记忆。",
        confidence: 0.8,
        salience: 0.8,
        evidence: [],
      },
    ]);

    const results = await retrieveMemories(DEMO_USER_ID, "scopecheck", {
      limit: 100,
    });
    const ids = results.map((memory) => memory.id);
    expect(ids).toContain("mem_scope_unfiltered");
    expect(ids).toContain("mem_scope_unfiltered_private");
  });
});

describe("memory decay", () => {
  const now = new Date("2026-10-22T12:00:00Z");

  it("halves semantic confidence and salience after one half-life", () => {
    const scores = decayMemoryScores(
      {
        confidence: 0.8,
        salience: 0.6,
        type: "semantic",
        createdAt: new Date("2026-07-24T12:00:00Z"),
        lastConfirmedAt: null,
      },
      { now },
    );
    expect(scores.factor).toBeCloseTo(0.5, 5);
    expect(scores.confidence).toBeCloseTo(0.4, 5);
    expect(scores.salience).toBeCloseTo(0.3, 5);
  });

  it("uses lastConfirmedAt instead of createdAt", () => {
    const scores = decayMemoryScores(
      {
        confidence: 0.8,
        salience: 0.6,
        type: "semantic",
        createdAt: new Date("2025-01-01T12:00:00Z"),
        lastConfirmedAt: new Date("2026-10-22T12:00:00Z"),
      },
      { now },
    );
    expect(scores.factor).toBeCloseTo(1, 5);
    expect(scores.confidence).toBeCloseTo(0.8, 5);
  });

  it("decays episodic memories faster than semantic ones", () => {
    const old = new Date("2026-09-22T12:00:00Z");
    const episodic = decayMemoryScores(
      {
        confidence: 0.8,
        salience: 0.6,
        type: "episodic",
        createdAt: old,
        lastConfirmedAt: null,
      },
      { now },
    );
    const semantic = decayMemoryScores(
      {
        confidence: 0.8,
        salience: 0.6,
        type: "semantic",
        createdAt: old,
        lastConfirmedAt: null,
      },
      { now },
    );
    expect(episodic.factor).toBeLessThan(semantic.factor);
  });

  it("never decays below the configured floor", () => {
    const scores = decayMemoryScores(
      {
        confidence: 0.8,
        salience: 0.6,
        type: "semantic",
        createdAt: new Date("2020-01-01T12:00:00Z"),
        lastConfirmedAt: null,
      },
      { now, minConfidence: 0.2, minSalience: 0.15 },
    );
    expect(scores.confidence).toBe(0.2);
    expect(scores.salience).toBe(0.15);
  });
});
