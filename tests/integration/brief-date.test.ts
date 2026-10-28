import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { reviews, users } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
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
