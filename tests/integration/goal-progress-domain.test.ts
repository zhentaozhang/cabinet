import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { goals, users } from "@/lib/db/schema";
import { setupWorkspace } from "@/lib/setup";
import { getPolicyConfig } from "@/lib/policy/config";
import { saveCheckin } from "@/server/services/commands/checkins";
import { recalculateGoalProgress } from "@/server/services/commands/progress";
import { resetDb } from "../helpers/db";

const USER = "usr_goal_domain";
const HEALTH_GOAL = "goal_domain_health";

/**
 * A goal outside the learning domain keeps its own progress.
 *
 * The learning formula reads the user's whole learning history (learning
 * templates, weekly check-ins, latest recall score), so running it on a health
 * goal wrote a number that had nothing to do with that goal — the review
 * measured a fake 18%–38% on every active goal after a single check-in.
 */
async function seedTwoDomains(): Promise<void> {
  await resetDb();
  await db.insert(users).values({
    id: USER,
    email: "goal-domain@cabinet.local",
    name: "Goal Domain",
    emailVerified: true,
    timezone: "Asia/Shanghai",
    updatedAt: new Date(),
  });
  await setupWorkspace({
    userId: USER,
    timezone: "Asia/Shanghai",
    goal: {
      title: "掌握 RAG 检索评估",
      why: "把学习变成可验证的进度",
      target: "能解释 recall、precision 和 rerank",
      horizon: "6 weeks",
      domain: "learning",
    },
  });
  await db.insert(goals).values({
    id: HEALTH_GOAL,
    userId: USER,
    domain: "health",
    title: "每周 3 次运动",
    why: "久坐 + 睡眠差",
    target: "连续 4 周，每周 3 次 25 分钟运动",
    horizon: "4 weeks",
    status: "active",
    // A value the learning formula cannot produce, so "unchanged" cannot be
    // confused with "recomputed to the same number".
    progress: 42,
  });
}

async function goalById(id: string) {
  const [row] = await db.select().from(goals).where(eq(goals.id, id));
  return row;
}

beforeEach(seedTwoDomains);

describe("goal progress is domain-scoped", () => {
  it("leaves a non-learning goal untouched by a check-in", async () => {
    await saveCheckin(
      {
        energy: 4,
        mood: 4,
        completed: [],
        note: "跑了 25 分钟",
        studyMinutes: 30,
        recallScore: 0.5,
        errorTags: ["rerank"],
      },
      USER,
    );

    const health = await goalById(HEALTH_GOAL);
    expect(health.progress).toBe(42);

    // The learning goal must still be recalculated, otherwise the guard would
    // have "fixed" the bug by disabling the feature.
    const [learning] = await db
      .select()
      .from(goals)
      .where(eq(goals.domain, "learning"));
    expect(learning.progress).toBeGreaterThan(0);
  });

  it("is a no-op when the task paths target a non-learning goal directly", async () => {
    // tasks/create.ts and tasks/audit.ts call this with whatever goal the task
    // belongs to, so the guard cannot live only in the user-wide caller.
    const config = await getPolicyConfig();
    await db.transaction(async (tx) => {
      await recalculateGoalProgress(tx, USER, HEALTH_GOAL, config.learning);
    });

    const health = await goalById(HEALTH_GOAL);
    expect(health.progress).toBe(42);
  });
});
