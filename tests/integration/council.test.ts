import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  auditEvents,
  councilPositions,
  dissents,
  goals,
  memories,
  tasks,
} from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { ConflictError } from "@/lib/domain/errors";
import { councilDecisionSchema } from "@/lib/validation/schemas";
import { applyOverride } from "@/server/services/commands/policy";
import { createCouncil, decideCouncil } from "@/server/services/engine";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 只跑一次会议，取 Chief 那一条立场——它的 claim 里写着议题挂在哪个目标上。 */
async function chiefPosition(topic: string) {
  const council = await createCouncil(
    { topic, trigger: "单笔支出 > ¥200" },
    DEMO_USER_ID,
  );
  const positions = await db
    .select()
    .from(councilPositions)
    .where(eq(councilPositions.councilId, council.id));
  const agentRows = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, DEMO_USER_ID));
  const chiefId = agentRows.find((agent) => agent.role === "chief")?.id;
  const chief = positions.find((position) => position.agentId === chiefId);
  if (!chief) throw new Error("chief position missing");
  return chief;
}

/** 只跑一次会议，取指定角色那一条立场（Researcher 的 claim 里写着引用了几条记忆）。 */
async function rolePosition(topic: string, role: string) {
  const council = await createCouncil(
    { topic, trigger: "单笔支出 > ¥200" },
    DEMO_USER_ID,
  );
  const positions = await db
    .select()
    .from(councilPositions)
    .where(eq(councilPositions.councilId, council.id));
  const agentRows = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, DEMO_USER_ID));
  const agentId = agentRows.find((agent) => agent.role === role)?.id;
  const position = positions.find((row) => row.agentId === agentId);
  if (!position) throw new Error(role + " position missing");
  return position;
}

/** 让最近的活儿落在某个目标上：任务的 createdAt 决定「最近」，目标的进度单独标出来。 */
async function latestWorkOn(goalId: string): Promise<void> {
  const stale = new Date(Date.now() - 60 * 60 * 1000);
  const fresh = new Date();
  for (const id of ["goal_rag", "goal_fitness"]) {
    await db
      .update(tasks)
      .set({ createdAt: id === goalId ? fresh : stale })
      .where(eq(tasks.goalId, id));
  }
}

describe("council closed loop", () => {
  it("generates five evidence-backed positions and a matrix", async () => {
    const topic = "要不要报名 8 周系统设计训练营？";
    const council = await createCouncil(
      {
        topic,
        trigger: "单笔支出 > ¥200",
      },
      DEMO_USER_ID,
    );

    expect(council.status).toBe("open");
    expect(council.matrix).not.toBeNull();
    expect(council.matrix?.support).toBeGreaterThanOrEqual(0);
    expect(council.matrix?.oppose).toBeGreaterThanOrEqual(0);
    expect(
      (council.matrix?.support ?? 0) +
        (council.matrix?.oppose ?? 0) +
        (council.matrix?.neutral ?? 0),
    ).toBe(5);

    const positions = await db
      .select()
      .from(councilPositions)
      .where(eq(councilPositions.councilId, council.id));
    expect(positions).toHaveLength(5);

    const agentRows = await db
      .select()
      .from(agents)
      .where(eq(agents.userId, DEMO_USER_ID));
    const roleById = new Map(agentRows.map((agent) => [agent.id, agent.role]));
    expect(positions.map((position) => roleById.get(position.agentId)).sort()).toEqual(
      ["chief", "coach", "critic", "researcher", "treasurer"],
    );

    for (const position of positions) {
      expect(position.evidence.length).toBeGreaterThan(0);
      expect(position.evidence.every((item) => Boolean(item.ref))).toBe(true);
      expect(position.scores).not.toBeNull();
      expect(position.claim.length).toBeGreaterThan(0);
      expect(position.claim).toContain(topic);
      expect(position.risk.length).toBeGreaterThan(0);
      expect(position.recommendation.length).toBeGreaterThan(0);
    }
  });

  /**
   * 财务官报的「本周已用」必须是能花的额度：额度按 Agent 分桶，一周能花的是各桶
   * 之和。原来它拿各 Agent 花费之和去除以单个 Agent 的上限（策略默认 60000 分），
   * 种子部署里 7 个 Agent 的额度合计才 7200 分，于是报出「剩余 60000 分」——一笔
   * 没有任何 Agent 拿得到的额度。
   */
  it("reports the Treasurer's budget against the caps that actually exist", async () => {
    const council = await createCouncil(
      { topic: "要不要报 8 周训练营？", trigger: "单笔支出 > ¥200" },
      DEMO_USER_ID,
    );
    const agentRows = await db
      .select()
      .from(agents)
      .where(eq(agents.userId, DEMO_USER_ID));
    const treasurerId = agentRows.find((agent) => agent.role === "treasurer")?.id;
    const positions = await db
      .select()
      .from(councilPositions)
      .where(eq(councilPositions.councilId, council.id));
    const treasurer = positions.find((position) => position.agentId === treasurerId);
    if (!treasurer) throw new Error("treasurer position missing");

    const capacity = agentRows.reduce(
      (sum, agent) => sum + (agent.budgetCents > 0 ? agent.budgetCents : 0),
      0,
    );
    expect(capacity).toBeGreaterThan(0);
    expect(treasurer.claim).toContain("额度合计");
    expect(treasurer.claim).toContain(`${capacity} 分`);
    expect(treasurer.claim).toContain("最紧的是");
    expect(treasurer.claim).not.toContain("本周预算已用");
  });
  it("always lets the Critic oppose and name the topic", async () => {
    const topic = "要不要买 ¥899 年包会员？";
    const council = await createCouncil(
      {
        topic,
        trigger: "单笔支出 > ¥500",
      },
      DEMO_USER_ID,
    );

    const positions = await db
      .select()
      .from(councilPositions)
      .where(eq(councilPositions.councilId, council.id));
    const agentRows = await db
      .select()
      .from(agents)
      .where(eq(agents.userId, DEMO_USER_ID));
    const criticId = agentRows.find((agent) => agent.role === "critic")?.id;
    const critic = positions.find((position) => position.agentId === criticId);

    expect(critic).toBeDefined();
    expect(critic?.stance).toBe("oppose");
    expect(critic?.isDissent).toBe(true);
    expect(critic?.claim).toContain(topic);
    expect(critic?.risk.length).toBeGreaterThan(0);
    expect(critic?.recommendation.length).toBeGreaterThan(0);
    expect(critic?.falsificationCondition).not.toBeNull();
    expect((council.matrix?.oppose ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("requires a reason before rejecting a council decision", () => {
    expect(
      councilDecisionSchema.safeParse({ decision: "reject", note: "   " })
        .success,
    ).toBe(false);
    expect(
      councilDecisionSchema.safeParse({ decision: "reject", note: "预算不足" })
        .success,
    ).toBe(true);
    expect(
      councilDecisionSchema.safeParse({ decision: "approve", note: "" }).success,
    ).toBe(true);
  });

  it("applies an approval to a task, memory and audit chain once", async () => {
    const council = await createCouncil(
      {
        topic: "要不要购买 RAG 课程？",
        trigger: "单笔支出 > ¥200",
      },
      DEMO_USER_ID,
    );

    const positions = await db
      .select()
      .from(councilPositions)
      .where(eq(councilPositions.councilId, council.id));
    const expectedDissents = positions.filter(
      (position) => position.isDissent || position.stance === "oppose",
    ).length;

    const decided = await decideCouncil(
      council.id,
      "approve",
      "批准，但设 7 天退款提醒。",
      DEMO_USER_ID,
    );

    expect(decided.status).toBe("decided");
    expect(decided.resolution?.decision).toBe("approve");
    expect(decided.resolution?.taskId).toBeTruthy();
    expect(decided.resolution?.memoryId).toBeTruthy();
    expect(decided.resolution?.dissents).toHaveLength(expectedDissents);
    expect(decided.resolutionAppliedAt).not.toBeNull();

    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, decided.resolution!.taskId!), eq(tasks.userId, DEMO_USER_ID)));
    expect(task).toBeDefined();
    expect(task.title).toContain("执行内阁决议");
    expect(task.assigneeId).not.toBe(task.auditorId);

    const [memory] = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.id, decided.resolution!.memoryId!),
          eq(memories.userId, DEMO_USER_ID),
        ),
      );
    expect(memory).toBeDefined();
    expect(memory.type).toBe("procedural");
    expect(memory.sourceEventId).toBe(council.id);

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, DEMO_USER_ID),
          eq(auditEvents.action, "council.decide"),
          eq(auditEvents.target, council.id),
        ),
      );
    expect(audit).toBeDefined();

    await expect(
      decideCouncil(council.id, "approve", "重复决定", DEMO_USER_ID),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("dates the follow-up task in the user own clock and says who made it", async () => {
    // 21:30Z 在示例用户（Asia/Shanghai）那里是第二天 05:30。跟进任务的正文
    // 以前写的是 new Date().toISOString()：UTC、带 Z、还差 8 小时。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T21:30:00.000Z"));

    const council = await createCouncil(
      { topic: "要不要把周三的课挪到周四？", trigger: "时间冲突" },
      DEMO_USER_ID,
    );
    const decided = await decideCouncil(
      council.id,
      "approve",
      "批准，周四上午执行。",
      DEMO_USER_ID,
    );

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, decided.resolution!.taskId!));
    expect(task.description).toContain(
      "内阁于 2026-10-29 05:30 批准：批准，周四上午执行。",
    );
    expect(task.description).not.toContain("2026-10-28T21:30");
    // 用户点的是「批准」，没有写过这条任务：来源是 system，不是 user。
    expect(task.createdBy).toBe("system");
  });

  it("records a rejection without creating a follow-up task", async () => {
    const council = await createCouncil(
      {
        topic: "要不要买年包会员？",
        trigger: "单笔支出 > ¥500",
      },
      DEMO_USER_ID,
    );

    const decided = await decideCouncil(
      council.id,
      "reject",
      "本月预算不足。",
      DEMO_USER_ID,
    );

    expect(decided.status).toBe("decided");
    expect(decided.resolution?.decision).toBe("reject");
    expect(decided.resolution?.taskId).toBeNull();
    expect(decided.resolution?.memoryId).toBeTruthy();

    const [memory] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, decided.resolution!.memoryId!));
    expect(memory.content).toContain("否决");
  });

  it("attaches the topic to the goal the latest work belongs to", async () => {
    // 演示用户有两个活跃目标：学习 goal_rag 与健康 goal_fitness。选哪个不该由
    // 物理行序决定——议题该挂在「最近在推的那个目标」上，进度也取那一个。
    await db.update(goals).set({ progress: 73 }).where(eq(goals.id, "goal_rag"));
    await db
      .update(goals)
      .set({ progress: 12 })
      .where(eq(goals.id, "goal_fitness"));

    await latestWorkOn("goal_fitness");
    const onFitness = await chiefPosition("要不要把慢跑加到每周四次？");
    expect(onFitness.claim).toContain("每周 3 次运动");
    // 健康目标的 progress 没有任何人在算（recalculateGoalProgress 只处理 learning
    // 域），12 是测试自己写进去的一个不会再动的数：Chief 不能把它当「当前进度」
    // 引用，证据也只能写归属。
    expect(onFitness.claim).not.toContain("当前进度 12%");
    expect(onFitness.claim).toContain("进度没有在算");
    expect(onFitness.evidence[0]?.ref).toBe("goal:goal_fitness");
    expect(onFitness.evidence[0]?.label).toBe("目标归属");
    expect(onFitness.evidence[0]?.quote).toBe("每周 3 次运动");

    await latestWorkOn("goal_rag");
    const onLearning = await chiefPosition("要不要把 RAG 练习拆成两次？");
    expect(onLearning.claim).toContain("6 周学会 RAG");
    expect(onLearning.claim).toContain("当前进度 73%");
    expect(onLearning.evidence[0]?.ref).toBe("goal:goal_rag");
    expect(onLearning.evidence[0]?.quote).toBe("73%");
  });

  it("counts all the week's tasks in the Chief's claim, not just the ones on screen", async () => {
    // 会议上下文只取最近 12 条任务渲染「最近的任务」，但 Chief 说的是「近 7 天有
    // N 个任务」——那是统计口径，不能被展示用的 limit 截断。
    // 种子自带的条数会随演示数据改动，期望值按库里实际的数推：这条用例断言的是
    // 「没有被展示用的 limit 截断」，不是某个具体的种子条数。
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [before] = await db
      .select({
        last7d: sql<number>`(count(*))::int`,
        accepted: sql<number>`(count(*) filter (where ${tasks.status} in ('accepted', 'done')))::int`,
      })
      .from(tasks)
      .where(and(eq(tasks.userId, DEMO_USER_ID), gte(tasks.createdAt, since)));

    await db.insert(tasks).values(
      Array.from({ length: 20 }, (_, index) => ({
        id: `tsk_bulk_${index}`,
        userId: DEMO_USER_ID,
        goalId: "goal_rag",
        title: `批量任务 ${index}`,
        description: "为了把「近 7 天任务数」撑过展示上限而插入的任务。",
        acceptanceCriteria: "存在即可。",
        status: "accepted",
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );

    const chief = await chiefPosition("要不要把本周的练习量再加一点？");
    expect(chief.claim).toContain(
      `近 7 天有 ${before.last7d + 20} 个任务，${before.accepted + 20} 个已验收`,
    );
  });

  it("stamps the dissent with the user's own reject-streak limit", async () => {
    // audit.rejectStreakLimit 是洞察采纳白名单里的键，也是 audit.ts 判「连续驳回，
    // 几次就暂停 Agent」的门槛。内阁写下的证伪条件必须与这个人实际会被暂停的阈值
    // 一致，否则复盘页上写着「>= 2 次驳回即证伪」，而 Agent 要到第 5 次才停。
    await applyOverride({
      userId: DEMO_USER_ID,
      key: "audit.rejectStreakLimit",
      value: 5,
    });

    const council = await createCouncil(
      { topic: "要不要报名周末的工作坊？", trigger: "单笔支出 > ¥200" },
      DEMO_USER_ID,
    );
    const positions = await db
      .select()
      .from(councilPositions)
      .where(eq(councilPositions.councilId, council.id));
    const agentRows = await db
      .select()
      .from(agents)
      .where(eq(agents.userId, DEMO_USER_ID));
    const criticId = agentRows.find((agent) => agent.role === "critic")?.id;
    const critic = positions.find((position) => position.agentId === criticId);
    expect(critic?.falsificationCondition?.threshold).toBe(5);

    // 旧会议（立场上没有随行保存条件）走 decide 的兜底分支，同样不能退回全局默认。
    await db
      .update(councilPositions)
      .set({ falsificationCondition: null })
      .where(eq(councilPositions.councilId, council.id));
    await decideCouncil(council.id, "approve", "批准。", DEMO_USER_ID);
    const dissentRows = await db
      .select()
      .from(dissents)
      .where(eq(dissents.councilId, council.id));
    const criticDissent = dissentRows.find((row) => row.agentId === criticId);
    expect(criticDissent?.condition.threshold).toBe(5);
    expect(dissentRows.every((row) => row.condition.threshold !== 2)).toBe(true);
  });

  /**
   * Researcher 的 claim 说「围绕议题找到 N 条相关记忆」，但会议上下文原来是全库
   * 显著性最高的 8 条，议题根本不让参与筛选：一条与议题无关的记忆会被说成「相关」，
   * 还会作为该立场的唯一证据被引用（evidence 里只有它一条 memory 引用）。现在按
   * src/lib/memory/retrieval.ts 的混合打分取，只留沾到议题词的条目。
   */
  it("feeds the Researcher the memories that mention the topic", async () => {
    await db.delete(memories).where(eq(memories.userId, DEMO_USER_ID));
    await db.insert(memories).values([
      {
        id: "mem_unrelated_council",
        userId: DEMO_USER_ID,
        type: "semantic",
        domain: "health",
        content: "夜里两点还在刷手机，第二天精力只有 2/5。",
        confidence: 0.9,
        salience: 0.99,
        evidence: [{ label: "打卡", ref: "chk_night", quote: "精力 2/5" }],
        status: "active",
      },
      {
        id: "mem_topic_council",
        userId: DEMO_USER_ID,
        type: "semantic",
        domain: "learning",
        content: "上次咨询：8 周训练营的完课率只有 40%，先按月验证。",
        confidence: 0.7,
        salience: 0.2,
        evidence: [{ label: "咨询记录", ref: "ccl_old", quote: "完课率 40%" }],
        status: "active",
      },
    ]);

    const researcher = await rolePosition("要不要报 8 周训练营？", "researcher");
    expect(researcher.claim).toContain("1 条相关记忆");
    expect(researcher.claim).toContain("完课率");
    // 全库显著性最高的那条与议题无关，不能进「相关记忆」。
    expect(researcher.claim).not.toContain("刷手机");
    expect(researcher.evidence[0]?.ref).toBe("memory:mem_topic_council");
  });

  it("says so when no memory mentions the topic", async () => {
    await db.delete(memories).where(eq(memories.userId, DEMO_USER_ID));
    await db.insert(memories).values({
      id: "mem_unrelated_only",
      userId: DEMO_USER_ID,
      type: "semantic",
      domain: "health",
      content: "夜里两点还在刷手机，第二天精力只有 2/5。",
      confidence: 0.9,
      salience: 0.99,
      evidence: [{ label: "打卡", ref: "chk_night", quote: "精力 2/5" }],
      status: "active",
    });

    const researcher = await rolePosition("要不要把厨房的刀换成一套新的？", "researcher");
    expect(researcher.claim).toContain("没有检索到相关的历史记忆");
    expect(
      researcher.evidence.some((item) => (item.ref ?? "").startsWith("memory:")),
    ).toBe(false);
  });
});
