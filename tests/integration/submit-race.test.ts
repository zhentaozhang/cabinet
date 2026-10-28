import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { artifacts, tasks } from "@/lib/db/schema";
import { ConflictError } from "@/lib/domain/errors";
import { DEMO_USER_ID } from "@/lib/demo";
import { createTask } from "@/server/services/engine";
import { submitTaskArtifact } from "@/server/services/commands/tasks/submit";
import { resetDb } from "../helpers/db";

/**
 * 重复提交与验收并发时，"提交成功"必须意味着"这次提交被验收流程看见了"。
 *
 * 复现方式是真并发：让另一个事务先锁住任务行并把它改成 accepted（模拟审计
 * 在这两步之间提交），再让提交走完。不同连接、不同事务，没有 mock。
 */

async function artifactCount(taskId: string): Promise<number> {
  const rows = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId));
  return rows.length;
}

/** 等到真有语句卡在行锁上：说明提交已经读到了 submitted 并写出了它的条件更新。 */
async function waitForLockWaiter(timeoutMs = 5000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const rows = (await db.execute(
      sql`select count(*)::int as waiting from pg_locks where not granted`,
    )) as Array<{ waiting: number }>;
    if (Number(rows[0]?.waiting ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

beforeEach(async () => {
  await resetDb();
});

describe("提交与验收并发", () => {
  it("任务在这期间被验收了 → 提交冲突，不留下没人验收的产物", async () => {
    const task = await createTask(
      {
        title: "解释事件循环",
        description: "用自己的话说清微任务与宏任务的先后。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        acceptanceCriteria: "讲清微任务先于宏任务。",
        estimateMin: 30,
        template: "learning",
      },
      DEMO_USER_ID,
    );

    // 第一版提交把任务带进 submitted —— 这时页面上的"再交一次"是允许的。
    await submitTaskArtifact({ taskId: task.id, content: "第一版答案" }, DEMO_USER_ID);
    const [submitted] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, task.id));
    expect(submitted.status).toBe("submitted");

    let locked!: () => void;
    let release!: () => void;
    const lockedPromise = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.id, task.id))
        .for("update");
      locked();
      await releasePromise;
      await tx
        .update(tasks)
        .set({ status: "accepted" })
        .where(eq(tasks.id, task.id));
    });
    await lockedPromise;

    const pending = submitTaskArtifact(
      { taskId: task.id, content: "第二版答案" },
      DEMO_USER_ID,
    );
    const settled = pending.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    // 提交必须真的去写那一行（否则它连"这行还是不是 submitted"都没问过）。
    const blocked = await waitForLockWaiter();
    release();
    await holder;
    const outcome = await settled;

    expect(blocked).toBe(true);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(ConflictError);
    }

    const [after] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, task.id));
    expect(after.status).toBe("accepted");
    // 第二版整条回滚：不留下"提交成功却永远不会被验收"的内容。
    expect(await artifactCount(task.id)).toBe(1);
  });
});
