import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import { GET } from "@/app/api/learning/mastery/route";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { UnauthorizedError } from "@/lib/domain/errors";
import { recordOutcome } from "@/server/services/commands/learning/mastery";
import { resetDb } from "../helpers/db";

const USER = "usr_mastery_route";
const OTHER = "usr_mastery_route_other";

let currentUser = USER;
let unauthorized = false;

vi.mock("@/lib/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/context")>();
  return {
    ...actual,
    getApiUserId: async () => {
      if (unauthorized) throw new UnauthorizedError();
      return currentUser;
    },
  };
});

type Topic = {
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

type Body = { ok?: boolean; code?: string; data?: { topics: Topic[]; dueCount: number } };

function userValues(id: string) {
  return {
    id,
    email: `${id}@cabinet.local`,
    name: "Mastery",
    emailVerified: true,
    timezone: "Asia/Shanghai",
    updatedAt: new Date(),
  };
}

beforeEach(async () => {
  currentUser = USER;
  unauthorized = false;
  await resetDb();
  await db.insert(users).values([userValues(USER), userValues(OTHER)]);
});

afterEach(() => {
  // 冻结时钟只在"数据库时钟"那个用例里用，别漏到后面的用例上。
  vi.useRealTimers();
});

async function call(): Promise<{ status: number; body: Body }> {
  const response = await GET(
    new Request("http://localhost:3000/api/learning/mastery"),
  );
  return { status: response.status, body: (await response.json()) as Body };
}

/** 把一条掌握度记录的到期时间改成相对**数据库** now() 的偏移，用来造逾期/未逾期。 */
async function shiftDueAt(userId: string, key: string, offset: string): Promise<void> {
  await db.execute(sql`
    UPDATE learning_mastery m
    SET due_at = now() ${sql.raw(offset)}
    FROM learning_topics t
    WHERE m.topic_id = t.id AND m.user_id = ${userId} AND t.key = ${key}
  `);
}

describe("GET /api/learning/mastery", () => {
  it("returns an empty list rather than 404 when nothing was ever reviewed", async () => {
    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data?.topics).toEqual([]);
    expect(body.data?.dueCount).toBe(0);
  });

  it("reports the reviewed topics weakest-first with their schedule", async () => {
    // 一错一对：掌握度 (1+1)/(2+2)=0.5，间隔回到 1 天（SM-2 答错重置）。
    await recordOutcome({ userId: USER, topicKey: "闭包", label: "闭包", correct: false });
    await recordOutcome({ userId: USER, topicKey: "闭包", label: "闭包", correct: true });

    const { status, body } = await call();
    expect(status).toBe(200);

    const topics = body.data?.topics ?? [];
    expect(topics.map((topic) => topic.topicKey)).toEqual(["闭包"]);

    const [topic] = topics;
    expect(topic.label).toBe("闭包");
    expect(topic.attempts).toBe(2);
    expect(topic.correct).toBe(1);
    expect(topic.mastery).toBeCloseTo(0.5, 5);
    // SM-2：答错把间隔压回 1 天，下一次答对从 1 天走到 3 天（nextSchedule）。
    expect(topic.intervalDays).toBe(3);
    expect(topic.isDue).toBe(false);
    expect(typeof topic.dueAt).toBe("string");
    expect(Number.isNaN(Date.parse(topic.dueAt ?? ""))).toBe(false);
    expect(topic.lastReviewedAt).not.toBeNull();
    expect(body.data?.dueCount).toBe(0);
  });

  it("decides isDue with the database clock, not the process clock", async () => {
    await recordOutcome({ userId: USER, topicKey: "事件循环", correct: true });
    await recordOutcome({ userId: USER, topicKey: "this 绑定", correct: true });
    await shiftDueAt(USER, "事件循环", "+ interval '30 minutes'");
    await shiftDueAt(USER, "this 绑定", "- interval '2 hours'");

    // 把进程时钟推到 1 小时后。若 isDue 由 new Date() 判定，"30 分钟后到期"
    // 的那条就会被误报成逾期；由数据库 now() 判定则仍然是未到期。
    const realNow = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(realNow + 60 * 60 * 1000);
    const { status, body } = await call();
    vi.useRealTimers();

    expect(status).toBe(200);
    const byKey = new Map((body.data?.topics ?? []).map((topic) => [topic.topicKey, topic]));
    expect(byKey.get("事件循环")?.isDue).toBe(false);
    expect(byKey.get("this 绑定")?.isDue).toBe(true);
    expect(body.data?.dueCount).toBe(1);
  });

  it("never returns another user's rows", async () => {
    await recordOutcome({ userId: OTHER, topicKey: "别人的主题", correct: true });
    await shiftDueAt(OTHER, "别人的主题", "- interval '1 hour'");

    const asUser = await call();
    expect(asUser.body.data?.topics).toEqual([]);
    expect(asUser.body.data?.dueCount).toBe(0);

    // 反过来读自己的：同一个 handler，只换当前登录人，就能看到那一行。
    currentUser = OTHER;
    const asOther = await call();
    expect((asOther.body.data?.topics ?? []).map((topic) => topic.topicKey)).toEqual([
      "别人的主题",
    ]);
    expect(asOther.body.data?.dueCount).toBe(1);
  });

  it("answers 401 for an anonymous request", async () => {
    unauthorized = true;
    const { status, body } = await call();
    expect(status).toBe(401);
    expect(body.code).toBe("unauthorized");
  });
});
