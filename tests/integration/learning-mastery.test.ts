import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { learningMastery, learningTopics, tasks, users } from "@/lib/db/schema";
import { setupWorkspace } from "@/lib/setup";
import { saveCheckin } from "@/server/services/commands/checkins";
import { ensureNextLearningTask } from "@/server/services/commands/learning";
import {
  dueTopics,
  listMastery,
  recordOutcome,
} from "@/server/services/commands/learning/mastery";
import { ConflictError } from "@/lib/domain/errors";
import { resetDb } from "../helpers/db";

const USER = "usr_learning_mastery";
const DAY_MS = 86_400_000;

let seq = 0;

beforeEach(async () => {
  await resetDb();
  // 每个用例一个独立用户：掌握度表不清空时也不会互相干扰。
  seq += 1;
  await db.insert(users).values({
    id: USER,
    email: `learning-mastery-${seq}@cabinet.local`,
    name: "Mastery",
    emailVerified: true,
    timezone: "Asia/Shanghai",
    updatedAt: new Date(),
  });
  await setupWorkspace({
    userId: USER,
    timezone: "Asia/Shanghai",
    goal: {
      title: "JavaScript 基础",
      why: "把零散知识变成可复习的结构",
      target: "能解释闭包、事件循环和 this",
      horizon: "6 weeks",
      domain: "learning",
    },
  });
});

async function masteryRow(userId: string, key: string) {
  const [row] = await db
    .select({
      attempts: learningMastery.attempts,
      correct: learningMastery.correct,
      mastery: learningMastery.mastery,
      easeFactor: learningMastery.easeFactor,
      intervalDays: learningMastery.intervalDays,
      dueAt: learningMastery.dueAt,
      lastReviewedAt: learningMastery.lastReviewedAt,
    })
    .from(learningMastery)
    .innerJoin(learningTopics, eq(learningMastery.topicId, learningTopics.id))
    .where(and(eq(learningTopics.userId, userId), eq(learningTopics.key, key)));
  return row;
}

async function learningTasks(userId: string) {
  return db.select().from(tasks).where(eq(tasks.userId, userId));
}

describe("per-topic mastery", () => {
  it("walks the interval 1 -> 3 days on correct answers and back to 1 on a wrong one", async () => {
    const first = await recordOutcome({
      userId: USER,
      topicKey: "  事件循环  ",
      correct: true,
    });
    expect(first.topicKey).toBe("事件循环");
    expect(first.intervalDays).toBe(1);
    expect(first.easeFactor).toBeCloseTo(2.6, 4);
    expect(first.attempts).toBe(1);
    expect(first.dueAt).not.toBeNull();
    expect(first.dueAt!.getTime()).toBeGreaterThan(Date.now());

    const second = await recordOutcome({
      userId: USER,
      topicKey: "事件循环",
      correct: true,
    });
    expect(second.intervalDays).toBe(3);
    expect(second.attempts).toBe(2);
    expect(second.easeFactor).toBeCloseTo(2.7, 4);

    const row = await masteryRow(USER, "事件循环");
    expect(row.mastery).toBe(0.75);
    expect(row.intervalDays).toBe(3);
    // dueAt 从数据库时钟算出来，必须晚于这次复习的时间。
    expect(row.dueAt!.getTime()).toBeGreaterThan(row.lastReviewedAt!.getTime());
    expect(row.dueAt!.getTime() - row.lastReviewedAt!.getTime()).toBeGreaterThan(
      2.9 * DAY_MS,
    );

    const wrong = await recordOutcome({
      userId: USER,
      topicKey: "事件循环",
      correct: false,
    });
    expect(wrong.intervalDays).toBe(1);
    expect(wrong.easeFactor).toBeCloseTo(2.5, 4);
    expect(wrong.attempts).toBe(3);
    expect(wrong.correct).toBe(2);
  });

  it("floors the ease factor at 1.3 instead of letting it collapse", async () => {
    await recordOutcome({ userId: USER, topicKey: "this", correct: true });
    const [topic] = await db
      .select({ id: learningTopics.id })
      .from(learningTopics)
      .where(
        and(eq(learningTopics.userId, USER), eq(learningTopics.key, "this")),
      );
    // 从 1.35 起步：下一次答错正好触到地板。
    await db
      .update(learningMastery)
      .set({ easeFactor: 1.35 })
      .where(eq(learningMastery.topicId, topic.id));

    const first = await recordOutcome({
      userId: USER,
      topicKey: "this",
      correct: false,
    });
    // float4 存不下精确的 1.3（实际落库是 1.29999995），所以列上的 CHECK 写成
    // `ease_factor >= 1.3::real`（迁移 0034）——否则下界值本身会被拒。
    expect(first.easeFactor).toBeGreaterThanOrEqual(1.3);
    expect(first.easeFactor).toBeCloseTo(1.3, 3);
    expect(first.easeFactor).toBeLessThan(1.31);

    const second = await recordOutcome({
      userId: USER,
      topicKey: "this",
      correct: false,
    });
    // 已经在地板上，再错也不能继续往下滑。
    expect(second.easeFactor).toBeCloseTo(first.easeFactor, 5);
    expect(second.intervalDays).toBe(1);
  });

  it("does not call one right answer 100% mastery", async () => {
    const result = await recordOutcome({
      userId: USER,
      topicKey: "闭包",
      correct: true,
    });
    expect(result.mastery).toBe(0.6667);
    expect(result.mastery).toBeLessThan(1);

    const missed = await recordOutcome({
      userId: USER,
      topicKey: "闭包",
      correct: false,
    });
    // 2 次、1 次答对 -> 2/4
    expect(missed.mastery).toBe(0.5);
  });

  it("rejects the losing write when two answers arrive at once", async () => {
    await recordOutcome({ userId: USER, topicKey: "并发", correct: true });

    const results = await Promise.allSettled([
      recordOutcome({ userId: USER, topicKey: "并发", correct: true }),
      recordOutcome({ userId: USER, topicKey: "并发", correct: true }),
    ]);

    const fulfilled = results.filter((item) => item.status === "fulfilled");
    const rejected = results.filter(
      (item): item is PromiseRejectedResult => item.status === "rejected",
    );
    expect(fulfilled.length + rejected.length).toBe(2);
    expect(fulfilled.length).toBeGreaterThan(0);
    // 二选一都算合格：要么输的那次拿到 ConflictError，要么它排在赢家之后
    // 读到新值再写。两者都要求「一次都不丢」。
    for (const item of rejected) {
      expect(item.reason).toBeInstanceOf(ConflictError);
    }

    const row = await masteryRow(USER, "并发");
    expect(row.attempts).toBe(1 + fulfilled.length);
    expect(row.correct).toBe(1 + fulfilled.length);
  });
});

describe("due topics", () => {
  it("lists never-reviewed topics first, then the overdue ones", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);
    await recordOutcome({
      userId: USER,
      topicKey: "闭包",
      correct: true,
      now: tenDaysAgo,
    });
    // 刚复习过的主题还没到期，不该出现在队列里。
    await recordOutcome({ userId: USER, topicKey: "this", correct: true });

    const due = await dueTopics(USER);
    expect(due.map((item) => item.topicKey)).toEqual(["闭包"]);
    expect(due[0].attempts).toBe(1);
    expect(due[0].mastery).toBe(0.6667);
    expect(due[0].dueAt!.getTime()).toBeLessThan(Date.now());

    // 只有 topic 行、还没有掌握度行时，dueAt 是 NULL，同样算「该复习」。
    await db.insert(learningTopics).values({
      id: "tpk_never_reviewed",
      userId: USER,
      key: "原型链",
      label: "原型链",
    });
    const withNewTopic = await dueTopics(USER);
    expect(withNewTopic.map((item) => item.topicKey)).toEqual([
      "原型链",
      "闭包",
    ]);
    expect(withNewTopic[0].dueAt).toBeNull();
    expect(withNewTopic[0].attempts).toBe(0);
    expect(withNewTopic[0].mastery).toBe(0);

    const all = await listMastery(USER);
    expect(all.map((item) => item.topicKey).sort()).toEqual(["this", "闭包"]);
    expect(all[0].mastery).toBeLessThanOrEqual(all[1].mastery);
  });
});

describe("scheduling from a due topic", () => {
  it("prefers the due topic over the check-in error tag", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);
    await recordOutcome({
      userId: USER,
      topicKey: "闭包",
      correct: true,
      now: tenDaysAgo,
    });

    await saveCheckin(
      {
        energy: 3,
        mood: 3,
        completed: [],
        note: "rerank 还是不熟",
        studyMinutes: 25,
        recallScore: 0.4,
        errorTags: ["rerank"],
      },
      USER,
    );

    const created = await learningTasks(USER);
    expect(created).toHaveLength(1);
    const [task] = created;
    expect(task.topicKey).toBe("闭包");
    expect(task.title).toBe("复习：闭包");
    expect(task.template).toBe("learning");
    expect(task.acceptanceChecklist).toEqual(
      expect.arrayContaining([
        { type: "judge", value: "能用自己的话正确解释「闭包」的核心要点", required: true },
      ]),
    );

    // 再次调度复用同一条进行中的任务，不会为同一个知识点建第二条。
    const again = await ensureNextLearningTask(USER);
    expect(again.id).toBe(task.id);
    expect(await learningTasks(USER)).toHaveLength(1);
  });

  it("falls back to the error tag and records its topic key when nothing is due", async () => {
    await saveCheckin(
      {
        energy: 3,
        mood: 3,
        completed: [],
        note: "promise 链没理顺",
        studyMinutes: 20,
        recallScore: 0.4,
        errorTags: ["  Promise  "],
      },
      USER,
    );

    const [task] = await learningTasks(USER);
    expect(task.title).toBe("回炉练习：Promise");
    expect(task.topicKey).toBe("promise");
    expect(
      task.acceptanceChecklist?.some((item) => item.type === "judge"),
    ).toBe(false);
  });

  it("uses the base topic when there is no history at all", async () => {
    const task = await ensureNextLearningTask(USER);
    expect(task.topicKey).toBe("基础概念");
    expect(task.title).toBe("下一步练习：基础概念");
  });
});

describe("scheduling reuses the task the learner still has in hand", () => {
  // 复用规则要覆盖"正在进行"的每一种状态。漏掉一个，学习者每打一次卡就会
  // 多拿到一道一模一样的题：needs_review 尤其明显——默认配置下判卷项没有
  // 模型就落在这里，任务停在等人判定，而打卡每天都会再来一次。
  const IN_HAND = [
    "planned",
    "assigned",
    "awaiting_approval",
    "approved",
    "running",
    "submitted",
    "auditing",
    "needs_review",
    "failed",
  ] as const;

  it.each(IN_HAND)("does not queue a second task while one is %s", async (status) => {
    const task = await ensureNextLearningTask(USER);
    const before = (await learningTasks(USER)).length;
    await db.update(tasks).set({ status }).where(eq(tasks.id, task.id));

    const again = await ensureNextLearningTask(USER);

    expect(again.id).toBe(task.id);
    expect(await learningTasks(USER)).toHaveLength(before);
  });

  it.each(["cancelled", "rejected", "accepted", "done"] as const)(
    "queues the next task once the last one is %s",
    async (status) => {
      const task = await ensureNextLearningTask(USER);
      const before = (await learningTasks(USER)).length;
      await db.update(tasks).set({ status }).where(eq(tasks.id, task.id));

      const again = await ensureNextLearningTask(USER);

      expect(again.id).not.toBe(task.id);
      expect(await learningTasks(USER)).toHaveLength(before + 1);
    },
  );
});
