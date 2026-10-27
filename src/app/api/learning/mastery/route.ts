import { and, eq, sql } from "drizzle-orm";

import { handleQueryWithRequest } from "@/lib/api/read";
import { db } from "@/lib/db";
import { learningMastery, learningTopics } from "@/lib/db/schema";
import { listMastery } from "@/server/services/commands/learning/mastery";

export type MasteryTopicView = {
  topicKey: string;
  label: string;
  mastery: number;
  attempts: number;
  correct: number;
  intervalDays: number;
  dueAt: string | null;
  isDue: boolean;
  lastReviewedAt: string | null;
};

export type MasteryOverview = {
  topics: MasteryTopicView[];
  /** 到期的主题总数（不受列表截断影响），给卡片标"该复习了"。 */
  dueCount: number;
};

/**
 * 掌握度只读视图：每个主题练得怎么样、下一次什么时候该复习。
 *
 * 为什么 isDue 由数据库算：到期与否是同一行数据上的判断，而 /review 与
 * pnpm tick 是两个进程。用进程时钟（new Date()）比较，多实例之间的漂移会让
 * 页面说"到期"、维护任务说"没到期"，用户看到的是自相矛盾的两句话。
 * recordOutcome 写 due_at 用的也是 Postgres 的 now()，这里用同一个时钟源比较。
 *
 * 为什么到期数单独查一次：listMastery 的 limit 有上限（50），拿它返回的行去
 * 数到期项，用户练到第 51 个主题那天就会少数。单独 count 才是真实总数，
 * 代价只是多一次索引扫描。
 */
export async function loadMasteryOverview(userId: string): Promise<MasteryOverview> {
  const [rows, dueRows] = await Promise.all([
    listMastery(userId),
    db
      .select({ topicKey: learningTopics.key })
      .from(learningMastery)
      .innerJoin(learningTopics, eq(learningMastery.topicId, learningTopics.id))
      .where(
        and(
          eq(learningMastery.userId, userId),
          sql`${learningMastery.dueAt} <= now()`,
        ),
      ),
  ]);

  const dueKeys = new Set(dueRows.map((row) => row.topicKey));

  return {
    topics: rows.map((row) => ({
      topicKey: row.topicKey,
      label: row.label,
      mastery: row.mastery,
      attempts: row.attempts,
      correct: row.correct,
      intervalDays: row.intervalDays,
      // 时间戳统一转 ISO 字符串：响应体是跨进程契约，Date 的 JSON 形态
      // 依赖序列化方，显式转换后客户端才不用猜。
      dueAt: row.dueAt ? row.dueAt.toISOString() : null,
      isDue: dueKeys.has(row.topicKey),
      lastReviewedAt: row.lastReviewedAt ? row.lastReviewedAt.toISOString() : null,
    })),
    dueCount: dueKeys.size,
  };
}

export async function GET(request: Request) {
  return handleQueryWithRequest(request, (userId) => loadMasteryOverview(userId));
}
