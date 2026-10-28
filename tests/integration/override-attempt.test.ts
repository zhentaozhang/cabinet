import { beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { artifacts, goals, learningAttempts } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { newId } from "@/lib/ids";
import {
  auditTask,
  createGoal,
  createTask,
  runTask,
} from "@/server/services/engine";
import { overrideAudit } from "@/server/services/commands/tasks/override";
import { resetDb } from "../helpers/db";

/**
 * 判卷行记着"这份答案被接受了吗"，任务行记着"这次验收通过了吗"。
 *
 * audit.ts 把两处写成同一句话（只有它能给出结论时）；人接手判定时也必须
 * 跟着改同一个字段，否则学习历史与任务结论会指着同一次作答说两句相反的话：
 * 任务页写"已通过"，导出的判卷历史写"未被接受"。
 */
async function learningTaskNeedingReview() {
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
  const audited = await auditTask(task.id, DEMO_USER_ID);
  expect(audited.decision).toBe("needs_review");

  const [artifact] = await db
    .select({ id: artifacts.id, content: artifacts.content })
    .from(artifacts)
    .where(eq(artifacts.taskId, task.id))
    .orderBy(desc(artifacts.createdAt))
    .limit(1);

  // 没接模型时 judge 连一条判卷行都不写；这里补上"模型判了但没判出来"的那一
  // 行 —— 那正是任务停在 needs_review 的另一种成因，也是人接手判定的现场。
  await db.insert(learningAttempts).values({
    id: newId("la"),
    userId: DEMO_USER_ID,
    taskId: task.id,
    artifactId: artifact?.id ?? null,
    prompt: task.title,
    answer: artifact?.content ?? "",
    rubric: ["能正确解释微任务与宏任务的先后"],
    verdicts: [
      {
        criterion: "能正确解释微任务与宏任务的先后",
        pass: false,
        reason: "解析失败：模型没有给出这条标准的判定",
        undetermined: true,
      },
    ],
    score: 0,
    judgedBy: "model",
    judgeModel: "stub-judge",
    accepted: false,
  });

  return task;
}

async function attemptOf(taskId: string) {
  const [row] = await db
    .select()
    .from(learningAttempts)
    .where(
      and(
        eq(learningAttempts.userId, DEMO_USER_ID),
        eq(learningAttempts.taskId, taskId),
      ),
    );
  return row;
}

beforeEach(async () => {
  await resetDb();
});

describe("人判之后判卷历史跟着改", () => {
  it("人判通过 → 已经落库的那次作答标成 accepted", async () => {
    const task = await learningTaskNeedingReview();
    expect((await attemptOf(task.id)).accepted).toBe(false);

    await overrideAudit({
      taskId: task.id,
      userId: DEMO_USER_ID,
      decision: "accepted",
      reason: "我对着答案看了一遍，讲得对。",
    });

    expect((await attemptOf(task.id)).accepted).toBe(true);
  });

  it("人判驳回 → 判卷行保持未接受", async () => {
    const task = await learningTaskNeedingReview();

    await overrideAudit({
      taskId: task.id,
      userId: DEMO_USER_ID,
      decision: "rejected",
      reason: "结论说反了，微任务是先跑的。",
    });

    const row = await attemptOf(task.id);
    expect(row.accepted).toBe(false);
    // 驳回不改写结论本身：模型说"没判出来"这条事实不该被人判覆盖。
    expect((row.verdicts ?? []).every((verdict) => verdict.undetermined)).toBe(true);
  });
});
