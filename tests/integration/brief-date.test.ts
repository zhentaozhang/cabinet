import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { goals, reviews, tasks, users } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { localDateKey } from "@/lib/domain/time";
import { regenerateBrief } from "@/server/services/commands/brief";
import { resetDb } from "../helpers/db";

/** 演示用户在东八区（src/lib/db/seed.ts:136）。 */
const SHANGHAI_USER = DEMO_USER_ID;
const WEST_COAST_USER = "usr_brief_west";

async function dailyReview(userId: string, period: string) {
  const [row] = await db
    .select()
    .from(reviews)
    .where(
      and(
        eq(reviews.userId, userId),
        eq(reviews.type, "daily"),
        eq(reviews.period, period),
      ),
    );
  return row ?? null;
}

function headingOf(content: string): string {
  return content.split("\n")[0] ?? "";
}

beforeEach(async () => {
  await resetDb();
  await db.insert(users).values({
    id: WEST_COAST_USER,
    email: "brief-west@cabinet.local",
    name: "West",
    emailVerified: true,
    timezone: "America/Los_Angeles",
    updatedAt: new Date(),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the morning brief is dated by the reader's clock", () => {
  it("uses the reader's date in the heading, not the server's", async () => {
    // 2026-10-26T23:30Z 对东八区已经是 27 日早上 7:30——早报正是这个时段生成的，
    // 而容器一般跑在 UTC 上。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T23:30:00Z"));

    const content = await regenerateBrief(SHANGHAI_USER);

    expect(headingOf(content)).toContain("10月27日");
    expect((await dailyReview(SHANGHAI_USER, "2026-10-27"))?.narrative).toBe(content);
    // 服务器那天（26 日）不该留下任何早报。
    expect(await dailyReview(SHANGHAI_USER, "2026-10-26")).toBeNull();
  });

  it("does not just add a day: a reader west of UTC keeps the earlier date", async () => {
    // 2026-10-26T03:00Z 对洛杉矶还是 25 日晚上 20:00。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T03:00:00Z"));

    const content = await regenerateBrief(WEST_COAST_USER);

    expect(headingOf(content)).toContain("10月25日");
    expect((await dailyReview(WEST_COAST_USER, "2026-10-25"))?.narrative).toBe(content);
    expect(await dailyReview(WEST_COAST_USER, "2026-10-26")).toBeNull();
  });

  it("agrees with the stored period when the server date is the reader's date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T09:00:00Z"));

    const content = await regenerateBrief(SHANGHAI_USER);

    // 东八区此刻是 26 日 17:00，服务器 UTC 也是 26 日。
    expect(headingOf(content)).toContain("10月26日");
    expect((await dailyReview(SHANGHAI_USER, "2026-10-26"))?.narrative).toBe(content);
  });
});

/**
 * 早报正文里那句「今天有 N 个待推进任务」。没有这行说明今天没有待推进的事。
 * 返回 null 是让文案被改坏时断言直接失败，而不是悄悄比较两个 null。
 */
function taskLineCount(content: string): number | null {
  const match = content.match(/今天有 (\d+) 个待推进任务/);
  return match ? Number(match[1]) : null;
}

describe("the brief counts what the page counts", () => {
  it("leaves out goals that are not in play and never invents a percentage", async () => {
    await db.insert(goals).values({
      id: "goal_paused",
      userId: SHANGHAI_USER,
      domain: "learning",
      title: "暂停学 RAG",
      why: "这季度先放一放",
      target: "暂不推进",
      horizon: "6 weeks",
      status: "paused",
      progress: 42,
      createdAt: new Date(),
    });

    const content = await regenerateBrief(SHANGHAI_USER);

    // 学习目标的进度是按验收与打卡现算的（src/server/services/commands/progress.ts），照印。
    expect(content).toMatch(/6 周学会 RAG（\d+%）/);
    // health 域没人再算：种子里那个 60 是写死的（src/lib/db/seed.ts:532）；
    // 首页用 goalProgressText 印「—」，早报以前印「60%」。
    expect(content).toContain("每周 3 次运动（—）");
    expect(content).not.toContain("每周 3 次运动（60%）");
    // 暂停的目标留在列表里是为了能找回来，不是当前方向。
    expect(content).not.toContain("暂停学 RAG");
  });

  it("counts only the tasks still in play, and never suggests a failed one", async () => {
    const before = taskLineCount(await regenerateBrief(SHANGHAI_USER));
    expect(before).not.toBeNull();

    // 失败与等审批的任务等的是人，不是进展：既不该进「待推进任务」的数字，
    // 也不该出现在「建议顺序」里被推荐成下一步。
    await db.insert(tasks).values([
      {
        id: "tsk_brief_failed",
        userId: SHANGHAI_USER,
        title: "失败的任务不该被推荐",
        description: "上次执行失败，等人处理。",
        acceptanceCriteria: "随便写点什么。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        status: "failed" as const,
        dueAt: null,
        createdBy: "user" as const,
        createdAt: new Date(),
      },
      {
        id: "tsk_brief_awaiting",
        userId: SHANGHAI_USER,
        title: "等审批的任务不该被数进去",
        description: "卡在审批上。",
        acceptanceCriteria: "随便写点什么。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        status: "awaiting_approval" as const,
        dueAt: null,
        createdBy: "user" as const,
        createdAt: new Date(),
      },
    ]);

    const content = await regenerateBrief(SHANGHAI_USER);
    expect(taskLineCount(content)).toBe(before);
    expect(content).not.toContain("失败的任务不该被推荐");
    expect(content).not.toContain("等审批的任务不该被数进去");

    // 徽章上的「基于 N 个任务」也必须读同一个数，否则正文与出处又对不上。
    const stored = await dailyReview(
      SHANGHAI_USER,
      localDateKey(new Date(), "Asia/Shanghai"),
    );
    expect(stored?.metrics.tasks).toBe(before);
  });
});
