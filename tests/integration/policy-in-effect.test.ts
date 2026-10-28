import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { agents, goals, tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { ensureNextLearningTask } from "@/server/services/commands/learning";
import { applyOverride } from "@/server/services/commands/policy";
import { saveCheckin } from "@/server/services/commands/checkins";
import { auditTask, createTask, runTask } from "@/server/services/engine";
import { escalationPolicyLine } from "@/lib/presentation/cabinet-view";
import { loadCabinet } from "@/server/readmodels/cabinet";
import { resetDb } from "../helpers/db";

// 一条洞察被采纳之后，运行时必须真的换了行为。只证明 getPolicyConfigFor
// 返回了新值不算数——那可能是"存进去了但没人读"。这里逐个打通到使用者。
beforeEach(async () => {
  await resetDb();
});

describe("被采纳的覆盖真的改变运行时", () => {
  it("learning.nextTask.minWords 决定下一道学习任务的字数门槛", async () => {
    const before = await ensureNextLearningTask(DEMO_USER_ID);
    const beforeItem = (before.acceptanceChecklist ?? []).find(
      (item) => item.type === "min_words",
    );
    expect(beforeItem).toBeDefined();

    // 先关掉刚建的任务，否则会命中"复用进行中任务"分支，看到的是旧清单。
    await db
      .update(tasks)
      .set({ status: "accepted" })
      .where(eq(tasks.id, before.id));

    await applyOverride({
      userId: DEMO_USER_ID,
      key: "learning.nextTask.minWords",
      value: 40,
    });

    const after = await ensureNextLearningTask(DEMO_USER_ID);
    const afterItem = (after.acceptanceChecklist ?? []).find(
      (item) => item.type === "min_words",
    );
    expect(afterItem?.type === "min_words" ? afterItem.value : null).toBe(40);
    expect(
      beforeItem?.type === "min_words" ? beforeItem.value : null,
    ).not.toBe(40);
  });

  it("audit.rejectStreakLimit 决定连续驳回几次会暂停 Agent", async () => {
    await applyOverride({
      userId: DEMO_USER_ID,
      key: "audit.rejectStreakLimit",
      value: 1,
    });

    const task = await createTask(
      {
        title: "写一段不可能达标的说明",
        description: "门槛刻意设成无法满足，让验收必然驳回。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        acceptanceCriteria: "写满 5000 字。",
        acceptanceChecklist: [{ type: "min_words", value: 5000, required: true }],
        estimateMin: 30,
      },
      DEMO_USER_ID,
    );
    await runTask(task.id, DEMO_USER_ID);
    const result = await auditTask(task.id, DEMO_USER_ID);
    expect(result.decision).toBe("rejected");

    const [coach] = await db
      .select({ status: agents.status, rejectStreak: agents.rejectStreak })
      .from(agents)
      .where(and(eq(agents.id, "ag_coach"), eq(agents.userId, DEMO_USER_ID)));
    // 默认阈值是 2，改成 1 之后第一次驳回就该停：证明读到的是用户级配置。
    expect(coach.rejectStreak).toBe(1);
    expect(coach.status).toBe("paused");
  });

  it("learning.targetCheckinsPerWeek 决定打卡能贡献多少目标进度", async () => {
    const [goal] = await db
      .select({ id: goals.id, progress: goals.progress })
      .from(goals)
      .where(and(eq(goals.userId, DEMO_USER_ID), eq(goals.domain, "learning")));
    expect(goal).toBeDefined();

    await saveCheckin(
      {
        energy: 3,
        mood: 3,
        completed: [],
        note: "基线",
        studyMinutes: 30,
        recallScore: 0.5,
        errorTags: [],
      },
      DEMO_USER_ID,
    );
    const [baseline] = await db
      .select({ progress: goals.progress })
      .from(goals)
      .where(eq(goals.id, goal.id));

    await applyOverride({
      userId: DEMO_USER_ID,
      key: "learning.targetCheckinsPerWeek",
      value: 1,
    });

    const [row] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, goal.id));
    // 覆盖不会回写历史进度，但下一次计算必须用新的分母。
    expect(row.progress).toBe(baseline.progress);

    await saveCheckin(
      {
        energy: 3,
        mood: 3,
        completed: [],
        note: "覆盖之后",
        studyMinutes: 30,
        recallScore: 0.5,
        errorTags: [],
      },
      DEMO_USER_ID,
    );
    const [after] = await db
      .select({ progress: goals.progress })
      .from(goals)
      .where(eq(goals.id, goal.id));
    // 本周打卡数不变，分母从 5 变 1，打卡项直接拉满 → 进度必须上升。
    expect(after.progress).toBeGreaterThan(baseline.progress);
  });

  it("内阁制度栏印的连续驳回上限就是真正执行的那个", async () => {
    // 制度栏原来写死「连续 2 次驳回 → 换人或进入退休评估」：那个 2 是默认值，
    // 而 audit.rejectStreakLimit 在洞察的覆盖白名单里。页面必须读同一个数，
    // 否则用户调到 5 之后，页面仍在承诺一个后端不执行的阈值。
    const before = await loadCabinet(DEMO_USER_ID);
    expect(before.policy.rejectStreakLimit).toBe(2);

    await applyOverride({
      userId: DEMO_USER_ID,
      key: "audit.rejectStreakLimit",
      value: 5,
    });

    const after = await loadCabinet(DEMO_USER_ID);
    expect(after.policy.rejectStreakLimit).toBe(5);
    expect(escalationPolicyLine(after.policy.rejectStreakLimit)).toContain(
      "连续驳回 5 次",
    );
  });
});