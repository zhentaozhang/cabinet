import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { getPolicyConfigFor } from "@/lib/policy/config";
import { db } from "@/lib/db";
import { goals } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import {
  auditTask,
  createGoal,
  createTask,
  runTask,
} from "@/server/services/engine";
import { overrideAudit } from "@/server/services/commands/tasks/override";
import { recalculateUserGoalProgress } from "@/server/services/commands/progress";
import { resetDb } from "../helpers/db";

async function progressOf(goalId: string): Promise<number> {
  const [row] = await db
    .select({ progress: goals.progress })
    .from(goals)
    .where(eq(goals.id, goalId));
  return row.progress;
}

beforeEach(async () => {
  await resetDb();
});

describe("人判之后目标进度跟着动", () => {
  it("人判通过一条待判定的学习任务 → 目标进度重算", async () => {
    const goal = await createGoal(
      {
        title: "掌握 JS 运行时",
        why: "想把异步这块补扎实",
        target: "能讲清事件循环",
        horizon: "3 个月",
        domain: "learning",
      },
      DEMO_USER_ID,
    );

    const task = await createTask(
      {
        goalId: goal.id,
        title: "解释事件循环",
        description: "用自己的话说清微任务与宏任务的先后。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        acceptanceCriteria: "讲清微任务先于宏任务。",
        // judge 项在没有模型时必然 undetermined，任务因此停在 needs_review ——
        // 这正是"只有人能给结论"的那条路径。
        acceptanceChecklist: [
          {
            type: "judge",
            value: "能正确解释微任务与宏任务的先后",
            required: true,
          },
        ],
        estimateMin: 30,
        template: "learning",
      },
      DEMO_USER_ID,
    );

    await runTask(task.id, DEMO_USER_ID);
    const audited = await auditTask(task.id, DEMO_USER_ID);
    expect(audited.decision).toBe("needs_review");

    // 种子数据里已有本周打卡与最近回忆分，所以基线不是 0；
    // 但 needs_review 不是通过，accepted/total 仍是 0/1。
    const before = await progressOf(goal.id);
    expect(before).toBeGreaterThan(0);

    await overrideAudit({
      taskId: task.id,
      userId: DEMO_USER_ID,
      decision: "accepted",
      reason: "我对着答案看了一遍，讲得对。",
    });

    // 判定之后 accepted/total = 1/1：任务比例从 0 变 1，按默认权重 0.5 涨 50 分。
    expect(await progressOf(goal.id)).toBe(Math.min(100, before + 50));
  });

  it("人判之后再算一遍，同一个库不该算出第二个数", async () => {
    const goal = await createGoal(
      {
        title: "掌握 JS 运行时",
        why: "想把异步这块补扎实",
        target: "能讲清事件循环",
        horizon: "3 个月",
        domain: "learning",
      },
      DEMO_USER_ID,
    );

    const task = await createTask(
      {
        goalId: goal.id,
        title: "解释事件循环",
        description: "用自己的话说清微任务与宏任务的先后。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        acceptanceCriteria: "讲清微任务先于宏任务。",
        acceptanceChecklist: [
          {
            type: "judge",
            value: "能正确解释微任务与宏任务的先后",
            required: true,
          },
        ],
        estimateMin: 30,
        template: "learning",
      },
      DEMO_USER_ID,
    );

    await runTask(task.id, DEMO_USER_ID);
    await auditTask(task.id, DEMO_USER_ID);
    await overrideAudit({
      taskId: task.id,
      userId: DEMO_USER_ID,
      decision: "accepted",
      reason: "我对着答案看了一遍，讲得对。",
    });

    const decided = await progressOf(goal.id);
    // 打卡、审计、出题都会触发这次重算；它只应该把同一份数据再算一次。
    const config = await getPolicyConfigFor(DEMO_USER_ID);
    await db.transaction((tx) =>
      recalculateUserGoalProgress(tx, DEMO_USER_ID, config.learning),
    );

    // 修复前：判定当场读到旧值，这次重算把它推到新值 —— 用户没做任何事，
    // 数字却在"下一次无关事件"到达时自己变了。
    expect(await progressOf(goal.id)).toBe(decided);
  });
});
