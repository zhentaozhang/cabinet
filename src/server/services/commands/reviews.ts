import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkins, reviews, tasks, users } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { logAuditTx } from "@/lib/audit";
import { localDateKey, weekRange } from "@/lib/domain/time";
import { LEARNING_TEMPLATES } from "@/lib/domain/learning";
import { getWeeklyMetrics } from "../queries/metrics";

export async function regenerateWeeklyReview(userId: string) {
  const metrics = await getWeeklyMetrics(userId);
  const [user] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId));
  const timezone = user?.timezone ?? "UTC";
  const range = weekRange(new Date(), timezone);

  const [learningTasks, recentCheckins] = await Promise.all([
    db
      .select({
        title: tasks.title,
        status: tasks.status,
        acceptedAt: tasks.acceptedAt,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          inArray(tasks.template, [...LEARNING_TEMPLATES]),
          gte(tasks.createdAt, range.start),
          lt(tasks.createdAt, range.end),
        ),
      )
      .orderBy(desc(tasks.acceptedAt))
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
  const completedTitles = learningTasks
    .filter((task) => ["accepted", "done"].includes(task.status))
    .map((task) => task.title);

  const narrative = [
    `# ${metrics.weekKey} 复盘`,
    "",
    "## 学习结果",
    `- 学习 ${metrics.studyMinutes} 分钟，完成 ${metrics.learningTasks} 个学习任务。`,
    `- ${recallLabel}。`,
    completedTitles.length > 0
      ? `- 已验收：${completedTitles.join("、")}。`
      : "- 本周还没有验收通过的学习任务。",
    `- 目标进度 ${Math.round(metrics.goalProgress)}%。`,
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
    metrics.managementMinutes === null
      ? "- 本周还没有管理时间样本。"
      : metrics.managementMinutesSource === "estimated"
        ? "- 管理时间目前是估算值，不纳入学习效果判断。"
        : `- 管理时间约 ${metrics.managementMinutes.toFixed(1)} 分钟/天。`,
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
          goalProgress: metrics.goalProgress,
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
            goalProgress: metrics.goalProgress,
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
