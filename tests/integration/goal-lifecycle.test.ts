import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

// `revalidatePath` 需要 Next 的静态渲染上下文，普通 vitest 进程里没有；
// 请求管线自己会读 `headers()`，同样只在请求作用域内可用。这两处替身只
// 替换"框架外部世界"，管线其余部分（限流、幂等、处理器）都跑真的。
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/context")>();
  const { DEMO_USER_ID } = await import("@/lib/demo");
  return { ...actual, getApiUserId: async () => DEMO_USER_ID };
});

import { POST } from "@/app/api/goals/[id]/route";
import { DEMO_USER_ID } from "@/lib/demo";
import { db } from "@/lib/db";
import { auditEvents, goals, users } from "@/lib/db/schema";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/lib/domain/errors";
import { transitionGoal } from "@/server/services/engine";
import { resetDb } from "../helpers/db";

const GOAL_ID = "goal_rag";
const OTHER_GOAL = "goal_other";
const OTHER_USER = "usr_goal_other";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function goalById(id = GOAL_ID) {
  const [row] = await db.select().from(goals).where(eq(goals.id, id));
  return row;
}

/** 只取这条目标写下的生命周期审计行，seed 里的其它审计与它无关。 */
async function goalAuditRows(id = GOAL_ID) {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(eq(auditEvents.action, "goal.status"), eq(auditEvents.target, id)),
    )
    .orderBy(auditEvents.seq);
}

function goalStatus(): Promise<string> {
  return goalById().then((row) => row.status);
}

/**
 * 让两个调用真的撞在同一行上。
 *
 * 直接 `Promise.all` 两个调用是不可靠的断言对象：第二个很可能在第一个提交
 * 之后才读到状态，于是拿到"非法迁移"(400) 而不是"状态变了"(409)——这断言
 * 的是谁先读，不是条件写回是否生效。
 *
 * 这里由测试自己先 `for update` 锁住目标行：两个调用都能读到 active（普通
 * SELECT 不被行锁阻塞），随后一起堵在 UPDATE 上。放行后先到的那条写成功，
 * 后到的那条按 `status = active` 重新判定，零行命中——这才是要测的竞争。
 */
async function withGoalRowLock<T>(
  run: () => Array<Promise<T>>,
): Promise<Array<PromiseSettledResult<T>>> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const holder = db.transaction(async (tx) => {
    await tx.execute(
      sql`select 1 from goals where id = ${GOAL_ID} for update`,
    );
    await gate;
  });

  // 等持锁事务真的拿到行锁（拿到之前调用方畅通无阻）。
  await sleep(100);
  const pending = Promise.allSettled(run());
  // 等两个调用都排到锁上：它们已经读完状态，差的只是那条 UPDATE。
  await sleep(300);
  release();

  const settled = await pending;
  await holder;
  return settled;
}

function transitionRequest(id: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/goals/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function callRoute(id: string, body: unknown): Promise<Response> {
  return POST(transitionRequest(id, body), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(async () => {
  await resetDb();
});

describe("goal lifecycle transitions", () => {
  const legal = [
    { action: "pause", setup: [], expect: "paused" },
    { action: "resume", setup: ["pause"], expect: "active" },
    { action: "complete", setup: [], expect: "completed" },
    { action: "complete", setup: ["pause"], expect: "completed" },
    { action: "archive", setup: ["complete"], expect: "archived" },
    {
      action: "reopen",
      setup: ["complete", "archive"],
      expect: "active",
    },
  ] as const;

  it.each(legal)(
    "$action from $setup lands on $expect",
    async ({ action, setup, expect: target }) => {
      for (const step of setup) {
        await transitionGoal({
          goalId: GOAL_ID,
          userId: DEMO_USER_ID,
          action: step,
        });
      }

      const updated = await transitionGoal({
        goalId: GOAL_ID,
        userId: DEMO_USER_ID,
        action,
      });

      expect(updated.id).toBe(GOAL_ID);
      expect(updated.status).toBe(target);
      expect(await goalStatus()).toBe(target);
    },
  );

  it("leaves progress alone when a goal is completed", async () => {
    // 进度是验收过的任务算出来的。按一下"完成"就把它写成 100，等于给用户看
    // 一个没有发生过的数字——真正的 100% 只能来自任务推进。
    // 种子的进度由 seedLearningProgress() 按公式算出来，不在这里钉死一个数字
    // （钉死 38 只能证明"种子里写着 38"，证明不了"完成不改进度"）。
    const before = await goalById();
    expect(Number.isFinite(before.progress)).toBe(true);

    await transitionGoal({
      goalId: GOAL_ID,
      userId: DEMO_USER_ID,
      action: "complete",
    });

    const after = await goalById();
    expect(after.status).toBe("completed");
    expect(after.progress).toBe(before.progress);
  });

  it("rejects completed → active and leaves the row untouched", async () => {
    const before = await goalById();
    await transitionGoal({
      goalId: GOAL_ID,
      userId: DEMO_USER_ID,
      action: "complete",
    });

    await expect(
      transitionGoal({
        goalId: GOAL_ID,
        userId: DEMO_USER_ID,
        action: "resume",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const after = await goalById();
    expect(after.status).toBe("completed");
    expect(after.progress).toBe(before.progress);
    // 失败的动作不留痕：审计里只有那次成功的 complete。
    expect(await goalAuditRows()).toHaveLength(1);
  });

  it("explains in Chinese what the goal can do instead", async () => {
    await transitionGoal({
      goalId: GOAL_ID,
      userId: DEMO_USER_ID,
      action: "complete",
    });

    const error = await transitionGoal({
      goalId: GOAL_ID,
      userId: DEMO_USER_ID,
      action: "resume",
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ValidationError);
    const message = (error as Error).message;
    expect(message).toContain("已完成");
    expect(message).toContain("恢复");
    // 提示是从状态表算出来的，所以它说的"还能做什么"必须真的是合法的下一步。
    expect(message).toContain("已归档");
  });

  it("refuses to archive a goal that is still moving", async () => {
    await expect(
      transitionGoal({
        goalId: GOAL_ID,
        userId: DEMO_USER_ID,
        action: "archive",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await goalStatus()).toBe("active");
  });

  it("treats a missing goal as not found", async () => {
    await expect(
      transitionGoal({
        goalId: "goal_missing",
        userId: DEMO_USER_ID,
        action: "pause",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not let one user move another user's goal", async () => {
    await db.insert(users).values({
      id: OTHER_USER,
      email: "goal-lifecycle@cabinet.local",
      name: "Goal Lifecycle",
      emailVerified: true,
      timezone: "Asia/Shanghai",
      updatedAt: new Date(),
    });
    await db.insert(goals).values({
      id: OTHER_GOAL,
      userId: OTHER_USER,
      domain: "health",
      title: "别人的目标",
      why: "验证跨用户隔离",
      target: "不被别人改动",
      horizon: "4 weeks",
      status: "active",
      progress: 0,
    });

    await expect(
      transitionGoal({
        goalId: OTHER_GOAL,
        userId: DEMO_USER_ID,
        action: "pause",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(await goalStatus()).toBe("active");
    expect((await goalById(OTHER_GOAL)).status).toBe("active");
  });

  it("records the status pair on a goal.status audit row", async () => {
    await transitionGoal({
      goalId: GOAL_ID,
      userId: DEMO_USER_ID,
      action: "pause",
    });

    const rows = await goalAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("goal.status");
    expect(rows[0].actor).toBe("user");
    expect(rows[0].target).toBe(GOAL_ID);
    expect(rows[0].userId).toBe(DEMO_USER_ID);
    // before/after 就是这次迁移本身；没有它们，审计只能说"目标动过"。
    expect(rows[0].before).toEqual({ status: "active" });
    expect(rows[0].after).toEqual({ status: "paused" });
  });

  it("lets exactly one of two concurrent pauses through", async () => {
    const settled = await withGoalRowLock(() => [
      transitionGoal({
        goalId: GOAL_ID,
        userId: DEMO_USER_ID,
        action: "pause",
      }),
      transitionGoal({
        goalId: GOAL_ID,
        userId: DEMO_USER_ID,
        action: "pause",
      }),
    ]);

    const fulfilled = settled.filter((entry) => entry.status === "fulfilled");
    const rejected = settled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictError);
    // 竞争失败的一方不许留下第二次迁移的痕迹。
    expect(await goalStatus()).toBe("paused");
    expect(await goalAuditRows()).toHaveLength(1);
  });
});

describe("POST /api/goals/[id]", () => {
  it("returns the updated goal", async () => {
    const response = await callRoute(GOAL_ID, { action: "pause" });
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      data: { goal: { id: string; status: string; progress: number } };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.goal.id).toBe(GOAL_ID);
    expect(payload.data.goal.status).toBe("paused");
    // 接口只是把行原样回传，进度就该是库里那个值。
    expect(payload.data.goal.progress).toBe((await goalById()).progress);
  });

  it("answers 400 for an action that is not in the vocabulary", async () => {
    const response = await callRoute(GOAL_ID, { action: "delete" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "validation_error",
    });
    expect(await goalStatus()).toBe("active");
  });

  it("answers 400 with the readable reason for an illegal transition", async () => {
    await transitionGoal({
      goalId: GOAL_ID,
      userId: DEMO_USER_ID,
      action: "complete",
    });

    const response = await callRoute(GOAL_ID, { action: "resume" });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string; error: string };
    expect(payload.code).toBe("validation_error");
    expect(payload.error).toContain("已完成");
  });

  it("answers 404 for a goal the caller cannot see", async () => {
    const response = await callRoute("goal_missing", { action: "pause" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("answers 409 when the row moved under the request", async () => {
    const settled = await withGoalRowLock(() => [
      callRoute(GOAL_ID, { action: "pause" }),
      callRoute(GOAL_ID, { action: "pause" }),
    ]);

    const fulfilled = settled.filter(
      (entry): entry is PromiseFulfilledResult<Response> =>
        entry.status === "fulfilled",
    );
    const statuses = fulfilled.map((entry) => entry.value.status).sort();
    // 两个请求都真的回来了，一个写成、一个被拒。
    expect(statuses).toEqual([200, 409]);

    const conflict = fulfilled.find((entry) => entry.value.status === 409);
    await expect(conflict!.value.json()).resolves.toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(await goalStatus()).toBe("paused");
  });
});
