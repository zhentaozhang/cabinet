import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkins, reviews, tasks, users } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { logAuditTx } from "@/lib/audit";
import { localDateKey, weekRange } from "@/lib/domain/time";
import { LEARNING_TEMPLATES } from "@/lib/domain/learning";
import { getWeeklyMetrics } from "../queries/metrics";
import { managementTimeLine } from "@/lib/presentation/review-view";

export async function regenerateWeeklyReview(userId: string) {
  const metrics = await getWeeklyMetrics(userId);
  const [user] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId));
  const timezone = user?.timezone ?? "UTC";
  const range = weekRange(new Date(), timezone);

  const [completedLearning, recentCheckins] = await Promise.all([
    // 只查已验收的学习任务：`order by accepted_at desc` 在 Postgres 里把
    // NULL 排在最前面（DESC 的默认是 NULLS FIRST），同周没做完的任务一多，
    // limit 5 就被它们占满，叙事会在「完成 N 个学习任务」的下一行写「本周
    // 还没有验收通过的学习任务」。同一份数据两次生成也不会换行：顺序用
    // accepted_at + id 排死。
    db
      .select({ title: tasks.title })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          inArray(tasks.template, [...LEARNING_TEMPLATES]),
          inArray(tasks.status, ["accepted", "done"]),
          // 与上面 getWeeklyMetrics 的 learningTasks 同一个窗口：数的是「这一周
          // 验收通过」的任务，不是「这一周新建」的。按创建时间挑标题，跨周做完
          // 的那道题就永远不出现在任何一篇复盘里。
          gte(tasks.acceptedAt, range.start),
          lt(tasks.acceptedAt, range.end),
        ),
      )
      .orderBy(sql`${tasks.acceptedAt} desc nulls last`, desc(tasks.id))
      .limit(5),
    db
      .select({
        date: checkins.date,
        studyMinutes: checkins.studyMinutes,
        recallScore: checkins.recallScore,
        errorTags: checkins.errorTags,
      })
      .from(checkins)
      .where(
        and(
          eq(checkins.userId, userId),
          gte(checkins.date, localDateKey(range.start, timezone)),
          lt(checkins.date, localDateKey(range.end, timezone)),
        ),
      )
      .orderBy(desc(checkins.date)),
  ]);

  const weakTopics = [
    ...new Set(recentCheckins.flatMap((row) => row.errorTags)),
  ].slice(0, 5);
  const recallLabel =
    metrics.recallAvg === null
      ? "本周还没有回忆数据"
      : `回忆正确率平均 ${Math.round(metrics.recallAvg * 100)}%`;
  const completedTitles = completedLearning.map((task) => task.title);

  // 没有活跃学习目标时整行不出现："目标进度 0%" 会让人以为目标存在但没动，
  // 而其实这一周根本没有可对照的目标。
  const goalLine =
    metrics.goalProgress === null
      ? []
      : [`- 目标进度 ${Math.round(metrics.goalProgress)}%。`];
  const narrative = [
    `# ${metrics.weekKey} 复盘`,
    "",
    "## 学习结果",
    `- 学习 ${metrics.studyMinutes} 分钟，完成 ${metrics.learningTasks} 个学习任务。`,
    `- ${recallLabel}。`,
    completedTitles.length > 0
      ? `- 已验收：${completedTitles.join("、")}。`
      : "- 本周还没有验收通过的学习任务。",
    ...goalLine,
    "",
    "## 薄弱点",
    weakTopics.length > 0
      ? weakTopics.map((topic) => `- ${topic}`).join("\n")
      : "- 本周没有记录错题标签。",
    "",
    "## 下周",
    weakTopics.length > 0
      ? `- 先重测「${weakTopics[0]}」，再进入新内容。`
      : "- 保持一次小练习，并记录回忆正确率。",
    // 这一行原来自己拼了一个「每天」的单位：managementMinutes 是本周合计，写错就等于
    // 把一周的总量说成一天的量。口径与文案搬到了 review-view（测试覆盖三态）。
    managementTimeLine({
      minutes: metrics.managementMinutes,
      // metrics 那边的字段是从聚合行推出来的普通 string（DTO 层才用 z.enum 收紧），
      // 这里显式收窄，而不是在 helper 里放宽成 string。
      source: metrics.managementMinutesSource === "estimated" ? "estimated" : "measured",
    }),
  ].join("\n");

  return db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(reviews)
      .values({
        id: newId("rev"),
        userId,
        period: metrics.weekKey,
        type: "weekly",
        narrative,
        metrics: {
          aao: metrics.aao,
          adherence: metrics.adherence ?? "",
          managementMin: metrics.managementMinutes ?? "",
          managementSource: metrics.managementMinutesSource,
          studyMinutes: metrics.studyMinutes,
          recallAvg: metrics.recallAvg ?? "",
          learningTasks: metrics.learningTasks,
          retestPassRate: metrics.retestPassRate ?? "",
          costCents: metrics.costCents,
          goalProgress: metrics.goalProgress ?? "",
          auditRejectRate: metrics.auditRejectRate ?? "",
        },
        decisions: [],
      })
      .onConflictDoUpdate({
        target: [reviews.userId, reviews.type, reviews.period],
        set: {
          narrative,
          metrics: {
            aao: metrics.aao,
            adherence: metrics.adherence ?? "",
            managementMin: metrics.managementMinutes ?? "",
            managementSource: metrics.managementMinutesSource,
            studyMinutes: metrics.studyMinutes,
            recallAvg: metrics.recallAvg ?? "",
            learningTasks: metrics.learningTasks,
            retestPassRate: metrics.retestPassRate ?? "",
            costCents: metrics.costCents,
            goalProgress: metrics.goalProgress ?? "",
            auditRejectRate: metrics.auditRejectRate ?? "",
          },
          decisions: [],
          createdAt: new Date(),
        },
      })
      .returning();

    await logAuditTx(tx, {
      userId,
      actor: "system",
      action: "review.weekly",
      target: saved.id,
      before: null,
      after: { period: metrics.weekKey },
    });

    return saved;
  });
}
