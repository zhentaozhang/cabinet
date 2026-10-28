import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  auditEvents,
  councilPositions,
  goals,
  memories,
  tasks,
} from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { ConflictError } from "@/lib/domain/errors";
import { councilDecisionSchema } from "@/lib/validation/schemas";
import { createCouncil, decideCouncil } from "@/server/services/engine";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
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
    expect(onFitness.claim).toContain("12");
    expect(onFitness.evidence[0]?.ref).toBe("goal:goal_fitness");

    await latestWorkOn("goal_rag");
    const onLearning = await chiefPosition("要不要把 RAG 练习拆成两次？");
    expect(onLearning.claim).toContain("6 周学会 RAG");
    expect(onLearning.claim).toContain("73");
    expect(onLearning.evidence[0]?.ref).toBe("goal:goal_rag");
  });

  it("counts all the week's tasks in the Chief's claim, not just the ones on screen", async () => {
    // 会议上下文只取最近 12 条任务渲染「最近的任务」，但 Chief 说的是「近 7 天有
    // N 个任务」——那是统计口径，不能被展示用的 limit 截断。
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
    // 种子里 10 个任务（5 个已验收）+ 上面 20 个已验收 = 30 / 25。
    expect(chief.claim).toContain("近 7 天有 30 个任务，25 个已验收");
  });
});
