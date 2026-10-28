import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, checkins, goals, tasks } from "@/lib/db/schema";
import { getPolicyConfigFor } from "@/lib/policy/config";
import { ValidationError } from "@/lib/domain/errors";
import {
  buildNextLearningTask,
  LEARNING_TEMPLATES,
  type LearningTopic,
} from "@/lib/domain/learning";
import { DEFAULT_TOPIC_KEY, normalizeTopicKey } from "@/lib/domain/mastery";
import { createTask } from "./tasks/create";
import { dueTopics } from "./learning/mastery";

/**
 * Queue the next study task for the active learning goal.
 *
 * Which topic to ask about, in order of authority:
 *   1. a topic that spaced repetition says is due — the schedule exists to be
 *      obeyed, and it knows about decay the check-in never sees;
 *   2. the first weak point from the latest check-in — the only free-form
 *      signal about what actually went wrong today;
 *   3. `基础概念` — a fresh loop with no history still needs somewhere to start.
 *
 * An open learning task is reused rather than queued twice: the learner can
 * only work on one at a time, and a second task would double-count the same
 * check-in.
 */
export async function ensureNextLearningTask(userId: string) {
  // 走用户级配置：反思采纳的 learning.nextTask.* 覆盖必须在这里生效，
  // 否则"我采纳了缩短作业字数"之后下的任务仍是旧长度。
  const config = await getPolicyConfigFor(userId);

  return db.transaction(async (tx) => {
    // "有没有在手任务"是一次查询，排队是紧接着的一次插入。两步之间必须互斥：
    // 打卡和手动"下一题"同时到达（或按钮被点两下）时，两个调用都看不到对方，
    // 各自建一道一模一样的题。学习者一次只能做一道，多出来的那道还会进目标
    // 进度的分母（"生成的任务里多少通过"）。
    //
    // 事务级咨询锁在提交/回滚时自动释放，不需要第二条连接来解锁；键按用户分，
    // 不同用户互不排队。
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"learning-next:" + userId}))`,
    );

    const [coach] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.userId, userId), eq(agents.role, "coach")))
      .limit(1);
    const [auditor] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.userId, userId), eq(agents.role, "auditor")))
      .limit(1);
    if (!coach || !auditor) {
      throw new ValidationError("Coach or Auditor is missing.");
    }

    const [goal] = await tx
      .select()
      .from(goals)
      .where(
        and(
          eq(goals.userId, userId),
          eq(goals.status, "active"),
          eq(goals.domain, "learning"),
        ),
      )
      .orderBy(desc(goals.createdAt))
      .limit(1);
    if (!goal) {
      throw new ValidationError("Create a learning goal first.");
    }

    const [existing] = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.goalId, goal.id),
          inArray(tasks.template, [...LEARNING_TEMPLATES]),
          // 反着写：只要任务还没了结，它就已经在手里了。以前这里正着列
          // planned/assigned/submitted，状态机后来加了 needs_review，默认配置下
          // 判卷没有模型就会停在那里等人判定——于是每打一次卡都会再发一道
          // 一模一样的题，而学习者一次只能做一道。
          //
          // 了结的只有四种：accepted / done 是做完的，cancelled 是撤回的，
          // rejected 是被驳回要重来的（重来就是新的一道）；suggested 是还没被
          // 接受的做法建议，不是已经排给学习者的任务。
          notInArray(tasks.status, [
            "accepted",
            "done",
            "cancelled",
            "rejected",
            "suggested",
          ]),
        ),
      )
      .orderBy(desc(tasks.createdAt))
      .limit(1);
    if (existing) return existing;

    const due = await dueTopics(userId, { limit: 1 });
    const dueTopic: LearningTopic | null =
      due.length > 0 ? { key: due[0].topicKey, label: due[0].label } : null;

    const [latestCheckin] = await tx
      .select()
      .from(checkins)
      .where(eq(checkins.userId, userId))
      .orderBy(desc(checkins.date))
      .limit(1);
    const [lastAccepted] = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.goalId, goal.id),
          inArray(tasks.template, [...LEARNING_TEMPLATES]),
          inArray(tasks.status, ["accepted", "done"]),
        ),
      )
      .orderBy(desc(tasks.acceptedAt))
      .limit(1);

    const daysSinceAccepted = lastAccepted?.acceptedAt
      ? (Date.now() - lastAccepted.acceptedAt.getTime()) / 86_400_000
      : null;
    // A due review and a retest of a failed answer are different errands, and a
    // task can only tell one story. The scheduled review wins; the retest
    // condition picks up again on the next task that has no due topic.
    const retest =
      !dueTopic &&
      Boolean(latestCheckin?.errorTags.length) &&
      daysSinceAccepted !== null &&
      daysSinceAccepted >= config.learning.nextTask.retestAfterDays;

    const errorTags = latestCheckin?.errorTags ?? [];
    const topicKey = dueTopic
      ? dueTopic.key
      : normalizeTopicKey(errorTags[0] ?? DEFAULT_TOPIC_KEY);

    const draft = buildNextLearningTask({
      goalTitle: goal.title,
      goalTarget: goal.target,
      latestRecallScore: latestCheckin?.recallScore ?? null,
      errorTags,
      retest,
      config: config.learning,
      // Only a scheduled review gets the topic framing; the check-in fallbacks
      // keep their existing titles and checklists.
      topic: dueTopic ?? undefined,
    });

    const created = await createTask(
      {
        goalId: goal.id,
        title: draft.title,
        description: draft.description,
        assigneeId: coach.id,
        auditorId: auditor.id,
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        acceptanceCriteria: draft.acceptanceCriteria,
        acceptanceChecklist: draft.acceptanceChecklist,
        estimateMin: draft.estimateMin,
        template: draft.template,
        createdBy: "agent",
      },
      userId,
      // 并入本事务：插入与上面那次"有没有在手任务"的查询必须看见同一个世界。
      tx,
    );

    // `topicKey` is the learning domain's own scheduling column, so it is written
    // here instead of widening createTask's shared signature with a field no
    // other domain needs. It is not a state change: `updatedAt` stays untouched.
    //
    // 和插入放在同一个事务里：以前这里吞掉错误，任务留着但排期列为空，下次排期
    // 就查不到"这道题属于哪个知识点"。要么两道都成，要么两道都不成。
    const [withTopic] = await tx
      .update(tasks)
      .set({ topicKey })
      .where(and(eq(tasks.id, created.id), eq(tasks.userId, userId)))
      .returning();

    return withTopic ?? created;
  });
}
