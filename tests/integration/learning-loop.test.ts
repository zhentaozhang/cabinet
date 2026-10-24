import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, artifacts, goals, tasks, users } from "@/lib/db/schema";
import { setupWorkspace } from "@/lib/setup";
import { saveCheckin } from "@/server/services/commands/checkins";
import { ensureNextLearningTask } from "@/server/services/commands/learning";
import { submitTaskArtifact } from "@/server/services/commands/tasks/submit";
import { auditTask } from "@/server/services/commands/tasks/audit";
import { regenerateWeeklyReview } from "@/server/services/commands/reviews";
import { getWeeklyMetrics } from "@/server/services/queries/metrics";
import { resetDb } from "../helpers/db";

const NEW_USER = "usr_learning_loop";

beforeEach(async () => {
  await resetDb();
  await db.insert(users).values({
    id: NEW_USER,
    email: "learning-loop@cabinet.local",
    name: "Learning Loop",
    emailVerified: true,
    timezone: "Asia/Shanghai",
    updatedAt: new Date(),
  });
});

describe("new-user learning loop", () => {
  it("goes from check-in to reviewed practice and weekly review", async () => {
    await setupWorkspace({
      userId: NEW_USER,
      timezone: "Asia/Shanghai",
      goal: {
        title: "掌握 RAG 检索评估",
        why: "把学习变成可验证的进度",
        target: "能解释 recall、precision 和 rerank",
        horizon: "6 weeks",
        domain: "learning",
      },
    });

    await saveCheckin(
      {
        energy: 4,
        mood: 4,
        completed: [],
        note: "rerank 还是不稳",
        studyMinutes: 30,
        recallScore: 0.4,
        errorTags: ["rerank"],
      },
      NEW_USER,
    );

    // Nothing calls ensureNextLearningTask here: saving the check-in has to be
    // what queues the next study task, otherwise the loop only advances when
    // someone remembers to press the button.
    const [task] = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, NEW_USER),
          inArray(tasks.template, ["learning", "learning_retest"]),
        ),
      )
      .limit(1);
    expect(task).toBeDefined();
    expect(task.template).toBe("learning");
    expect(task.title).toContain("rerank");
    expect(task.assigneeId).not.toBeNull();

    // Asking again reuses the open task rather than queueing a second one.
    await expect(ensureNextLearningTask(NEW_USER)).resolves.toMatchObject({
      id: task.id,
    });

    const [coachBefore] = await db
      .select()
      .from(agents)
      .where(eq(agents.userId, NEW_USER))
      .limit(1);

    const submitted = await submitTaskArtifact(
      {
        taskId: task.id,
        title: "我的 rerank 理解",
        content: [
          "# 答案",
          "",
          "rerank 是在初筛之后，用更贵的模型重新排列候选文档。",
          "它和 recall 的区别是：recall 关心有没有找全，rerank 关心排序是否把真正相关的放前面。",
          "一个具体例子是：先用向量检索取回二十篇文档，再用交叉编码器逐篇打分，最后保留前三篇。",
          "如果 rerank 不稳定，先检查训练数据和候选集分布，再用小批量对比实验验证。",
          "这段答案故意写得更长，确保通过最小字数要求，并包含 rerank 这个薄弱点。",
        ].join("\n"),
      },
      NEW_USER,
    );

    const [submittedArtifact] = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, submitted.artifactId));
    expect(submittedArtifact.sourceType).toBe("user_input");

    await expect(auditTask(task.id, NEW_USER)).resolves.toMatchObject({
      decision: "accepted",
    });

    const [savedTask] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id));
    expect(savedTask.status).toBe("accepted");

    const [goal] = await db
      .select()
      .from(goals)
      .where(eq(goals.userId, NEW_USER));
    expect(goal.progress).toBeGreaterThan(0);

    const [coachAfter] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, coachBefore.id));
    expect(coachAfter.successCount).toBe(coachBefore.successCount);

    const metrics = await getWeeklyMetrics(NEW_USER);
    expect(metrics.studyMinutes).toBe(30);
    expect(metrics.recallAvg).toBeCloseTo(0.4);
    expect(metrics.learningTasks).toBe(1);

    const review = await regenerateWeeklyReview(NEW_USER);
    expect(review.narrative).toContain("rerank");
    expect(review.metrics.studyMinutes).toBe(30);

    const again = await regenerateWeeklyReview(NEW_USER);
    expect(again.id).toBe(review.id);
  });

  it("keeps the check-in when there is no learning goal to continue", async () => {
    const NO_GOAL = "usr_learning_no_goal";
    await db.insert(users).values({
      id: NO_GOAL,
      email: "learning-no-goal@cabinet.local",
      name: "No Goal",
      emailVerified: true,
      timezone: "Asia/Shanghai",
      updatedAt: new Date(),
    });

    // Scheduling the next task needs a coach, an auditor and a learning goal.
    // None of that should be able to lose the check-in the user just wrote.
    await expect(
      saveCheckin(
        {
          energy: 3,
          mood: 3,
          completed: [],
          note: "还没定学习目标，先记一笔",
        },
        NO_GOAL,
      ),
    ).resolves.toBeUndefined();

    const created = await db
      .select()
      .from(tasks)
      .where(eq(tasks.userId, NO_GOAL));
    expect(created).toHaveLength(0);
  });

  it("rejects learner submissions for external tasks", async () => {
    await setupWorkspace({
      userId: NEW_USER,
      timezone: "Asia/Shanghai",
      goal: {
        title: "学习",
        why: "why",
        target: "target",
        horizon: "6 weeks",
        domain: "learning",
      },
    });
    const [coach] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.userId, NEW_USER), eq(agents.role, "coach")));
    const [auditor] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.userId, NEW_USER), eq(agents.role, "auditor")));
    const [task] = await db
      .insert(tasks)
      .values({
        id: "tsk_external_learning_test",
        userId: NEW_USER,
        title: "外部动作",
        description: "not a learner task",
        assigneeId: coach.id,
        auditorId: auditor.id,
        status: "planned",
        actionType: "external",
        resource: "calendar",
        acceptanceCriteria: "n/a",
        estimateMin: 10,
        createdBy: "agent",
      })
      .returning();

    await expect(
      submitTaskArtifact(
        { taskId: task.id, content: "not allowed" },
        NEW_USER,
      ),
    ).rejects.toThrow(/Only internal tasks/);
  });
});
