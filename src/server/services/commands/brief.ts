import { db } from "@/lib/db";
import { reviews } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { localDateKey, localDateTimeParts } from "@/lib/domain/time";
import { getTodayData } from "../queries/today";
import {
  briefDecisionLine,
  briefGoalLine,
  briefOrderList,
  briefTaskLine,
} from "@/lib/presentation/brief-view";
import { inFlightTasks } from "@/lib/presentation/today-view";

export async function regenerateBrief(userId: string) {
  const data = await getTodayData(userId);
  // 标题与 period 必须是同一个日期。早报在早上生成，而容器一般跑在 UTC 上：
  // 东八区 07:30 时服务器还在前一天 23:30，用进程时区写标题会让同一份早报里
  // 出现两个日期（标题 26 日、period 与页头 27 日）。
  const now = new Date();
  const today = localDateTimeParts(now, data.user.timezone);
  const inFlight = inFlightTasks(data.tasks);
  const lines = [
    `# ${today.month}月${today.day}日 早报`,
    "",
    /*
      「目标」与「今天有 N 个待推进任务」这两行有专门的函数（src/lib/presentation/
      brief-view.ts）：首页那条兜底早报用的是同一对函数。以前这里自己 map 了
      `data.goals` 的每个目标、数的是整张 `tasks` 表，于是「重新生成早报」写下的
      正文会和同一屏的页头对不上——暂停目标照样算方向、健身目标那个写死的 60%
      照样印、失败任务被数成「待推进」。
    */
    `目标：${briefGoalLine(data.goals)}`,
    "",
    "## 今天的关键判断",
    `- ${briefTaskLine(data.tasks)}`,
    briefDecisionLine({
      approvals: data.approvals.length,
      hasCouncil: Boolean(data.council),
    }),
    "",
    "## 建议顺序",
    ...briefOrderList(data.tasks),
  ];
  const content = lines.join("\n");
  const metrics = {
    // 徽章上写「基于 N 个任务」，N 必须是正文那个数：推进中的任务，
    // 不含失败与等审批的（正文那行由 briefTaskLine 现算，同一子集）。
    tasks: inFlight.length,
    decisions: data.approvals.length,
  };
  await db
    .insert(reviews)
    .values({
      id: newId("rev"),
      userId,
      period: localDateKey(now, data.user.timezone),
      type: "daily",
      narrative: content,
      metrics,
      decisions: [],
    })
    .onConflictDoUpdate({
      target: [reviews.userId, reviews.type, reviews.period],
      set: { narrative: content, metrics, decisions: [], createdAt: new Date() },
    });
  return content;
}
