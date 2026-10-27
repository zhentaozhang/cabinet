import { beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { artifacts, learningMastery, learningTopics, tasks } from "@/lib/db/schema";
import type { AcceptanceItem } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { auditTask, createTask, runTask } from "@/server/services/engine";
import { resetDb } from "../helpers/db";

// 审计是学习回路的唯一判决点：掌握度只能由这里的结论推进，
// 否则"我今天复习对了吗"会有一半来自自报、一半来自验收，两个数字打架。
async function setupLearningTask(options: {
  topicKey: string;
  checklist: AcceptanceItem[];
  template?: string | null;
}): Promise<string> {
  const task = await createTask(
    {
      title: "解释闭包",
      description: "用自己的话解释闭包为什么能捕获外部变量。",
      assigneeId: "ag_coach",
      auditorId: "ag_auditor",
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 0,
      acceptanceCriteria: "讲清闭包能捕获变量的原因。",
      acceptanceChecklist: options.checklist,
      estimateMin: 30,
      template: options.template === undefined ? "learning" : options.template,
    },
    DEMO_USER_ID,
  );
  // createTask 不认 topic_key（那是学习域自己的排期列），这里直接回写，
  // 模拟 ensureNextLearningTask 建完任务后的状态。
  await db
    .update(tasks)
    .set({ topicKey: options.topicKey })
    .where(eq(tasks.id, task.id));
  await runTask(task.id, DEMO_USER_ID);
  return task.id;
}

async function masteryFor(topicKey: string) {
  const [row] = await db
    .select({
      attempts: learningMastery.attempts,
      correct: learningMastery.correct,
      intervalDays: learningMastery.intervalDays,
      dueAt: learningMastery.dueAt,
      mastery: learningMastery.mastery,
    })
    .from(learningMastery)
    .innerJoin(learningTopics, eq(learningMastery.topicId, learningTopics.id))
    .where(
      and(
        eq(learningTopics.userId, DEMO_USER_ID),
        eq(learningTopics.key, topicKey),
      ),
    );
  return row;
}

beforeEach(async () => {
  await resetDb();
});

describe("审计结论推进掌握度", () => {
  it("验收通过 → 该知识点的复习间隔开始走动", async () => {
    const taskId = await setupLearningTask({
      topicKey: "闭包",
      checklist: [{ type: "min_words", value: 5, required: true }],
    });

    const result = await auditTask(taskId, DEMO_USER_ID);
    expect(result.decision).toBe("accepted");

    const row = await masteryFor("闭包");
    expect(row).toBeDefined();
    expect(row.attempts).toBe(1);
    expect(row.correct).toBe(1);
    expect(row.intervalDays).toBe(1);
    expect(row.mastery).toBeGreaterThan(0);
    expect(row.dueAt).not.toBeNull();
  });

  it("验收驳回 → 计入尝试但不计入正确，间隔回到 1 天", async () => {
    const taskId = await setupLearningTask({
      topicKey: "事件循环",
      checklist: [{ type: "min_words", value: 500, required: true }],
    });

    const result = await auditTask(taskId, DEMO_USER_ID);
    expect(result.decision).toBe("rejected");

    const row = await masteryFor("事件循环");
    expect(row.attempts).toBe(1);
    expect(row.correct).toBe(0);
    expect(row.intervalDays).toBe(1);
    // masteryFrom 用拉普拉斯平滑，(0+1)/(1+2) —— 一次没答对不等于"完全不会"。
    expect(row.mastery).toBeCloseTo(1 / 3, 4);
  });

  it("同一知识点两次验收 → 间隔推进到 3 天", async () => {
    for (let i = 0; i < 2; i += 1) {
      const taskId = await setupLearningTask({
        topicKey: "prototype",
        checklist: [{ type: "min_words", value: 5, required: true }],
      });
      await auditTask(taskId, DEMO_USER_ID);
    }

    const row = await masteryFor("prototype");
    expect(row.attempts).toBe(2);
    expect(row.correct).toBe(2);
    expect(row.intervalDays).toBe(3);
  });

  it("非学习模板即使带了 topicKey 也不写掌握度", async () => {
    const taskId = await setupLearningTask({
      topicKey: "不该被记录",
      template: "generic",
      checklist: [{ type: "min_words", value: 5, required: true }],
    });

    await auditTask(taskId, DEMO_USER_ID);

    expect(await db.select().from(learningTopics)).toHaveLength(0);
    expect(await db.select().from(learningMastery)).toHaveLength(0);
  });

  it("清单里全是确定性项 → 结论写「逐项通过」", async () => {
    const taskId = await setupLearningTask({
      topicKey: "确定性项",
      checklist: [{ type: "min_words", value: 5, required: true }],
    });

    const result = await auditTask(taskId, DEMO_USER_ID);
    expect(result.reason).toBe("验收清单逐项通过。");
    expect(await masteryFor("确定性项")).toBeDefined();
  });

  it("判卷没跑出结论 → 任务停在待你判定，也不算这次复习", async () => {
    const taskId = await setupLearningTask({
      topicKey: "闭包捕获的是变量",
      checklist: [
        { type: "min_words", value: 5, required: true },
        {
          type: "judge",
          value: "能说清闭包捕获的是变量本身而不是值的拷贝",
          required: true,
        },
      ],
    });

    // 测试环境没有 OPENAI_API_KEY，判卷必然停在 undetermined。
    const result = await auditTask(taskId, DEMO_USER_ID);

    // 未判定不是失败，但也绝不是通过：没有结论的任务不能写成 accepted。
    expect(result.decision).toBe("needs_review");
    expect(result.verdict).toBe("needs_review");
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("needs_review");
    expect(result.reason).toContain("没有结论");
    expect(result.reason).toContain("模型判卷");
    expect(result.reason).not.toContain("逐项通过");

    // 没有结论就不推进掌握度：把"没判"当成"答对"会让复习间隔凭空翻倍，
    // 当成"答错"又会在不知道对错时把间隔压回去，两者都比不记失真。
    expect(await db.select().from(learningTopics)).toHaveLength(0);
    expect(await db.select().from(learningMastery)).toHaveLength(0);
  });

  it("学习模板没有 topicKey 时不凭空造一个知识点", async () => {
    const task = await createTask(
      {
        title: "老式学习任务",
        description: "改造前建的任务没有 topic_key。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        acceptanceCriteria: "写成段。",
        acceptanceChecklist: [{ type: "min_words", value: 5, required: true }],
        estimateMin: 30,
        template: "learning",
      },
      DEMO_USER_ID,
    );
    await runTask(task.id, DEMO_USER_ID);
    await auditTask(task.id, DEMO_USER_ID);

    expect(await db.select().from(learningTopics)).toHaveLength(0);
    const [artifact] = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.taskId, task.id))
      .orderBy(desc(artifacts.createdAt))
      .limit(1);
    expect(artifact).toBeDefined();
  });
});
