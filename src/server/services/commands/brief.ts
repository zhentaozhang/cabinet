import { db } from "@/lib/db";
import { reviews } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { localDateKey } from "@/lib/domain/time";
import { getTodayData } from "../queries/today";

export async function regenerateBrief(userId: string) {
  const data = await getTodayData(userId);
  const lines = [
    `# ${new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric" })} 早报`,
    "",
    `目标：${data.goals.map((g) => `${g.title}（${Math.round(g.progress)}%）`).join(" · ")}`,
    "",
    "## 今天的关键判断",
    data.tasks.length > 0
      ? `- 今天有 ${data.tasks.length} 个待推进任务，优先处理已提交待验收的。`
      : "- 今天没有待推进任务，适合复盘或补弱项。",
    `- 需要你决定：${data.approvals.length} 个审批${data.council ? " + 1 个内阁会议" : ""}。`,
    "",
    "## 建议顺序",
    ...data.tasks.slice(0, 3).map((t, i) => `${i + 1}. ${t.title}（${t.estimateMin} 分钟）`),
  ];
  const content = lines.join("\n");
  const metrics = {
    tasks: data.tasks.length,
    decisions: data.approvals.length,
  };
  await db
    .insert(reviews)
    .values({
      id: newId("rev"),
      userId,
      period: localDateKey(new Date(), data.user.timezone),
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
