import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  agents,
  learningAttempts,
  learningMastery,
  learningTopics,
  policyOverrides,
  tasks,
  users,
} from "@/lib/db/schema";
import { deleteAccount } from "@/lib/account";
import { exportAccountNdjson } from "@/lib/account-export";
import { setupWorkspace } from "@/lib/setup";
import { applyOverride } from "@/server/services/commands/policy";
import type { JudgeFn } from "@/server/services/commands/tasks/judge";
import { auditTask, createTask, runTask } from "@/server/services/engine";
import { resetDb } from "../helpers/db";

const USER = "usr_account_delete";
const CRITERION = "解释闭包为什么能捕获变量";

async function seedUser(id: string): Promise<void> {
  await db.insert(users).values({
    id,
    email: id + "@cabinet.local",
    name: "Account Delete",
    emailVerified: true,
    timezone: "Asia/Shanghai",
    updatedAt: new Date(),
  });
}

/**
 * 造一条真实的学习历史：setupWorkspace 建 7 个 Agent 和一个 learning 目标，
 * 学习模板任务带 judge 项走完 runTask + auditTask（写 learning_topics /
 * learning_mastery / learning_attempts），再采纳一条策略覆盖
 * （写 policy_overrides）。
 *
 * 为什么必须走真实命令而不是直接 insert：这四张表只在真有人写过行的时候才
 * 会拦住删号，手写 fixture 很容易漏掉某个引用列（artifact_id / topic_id），
 * 那样测出来的"通过"只是没造出阻塞。
 */
async function seedLearningHistory(): Promise<string> {
  const { goalId } = await setupWorkspace({
    userId: USER,
    timezone: "Asia/Shanghai",
    goal: {
      title: "准备系统设计面试",
      why: "换工作",
      target: "完成 20 道题",
      horizon: "8 weeks",
      domain: "learning",
    },
  });
  const created = await db.select().from(agents).where(eq(agents.userId, USER));
  const coach = created.find((row) => row.role === "coach")!;
  const auditor = created.find((row) => row.role === "auditor")!;

  const task = await createTask(
    {
      goalId,
      title: "解释闭包",
      description: "用自己的话解释闭包为什么能捕获外部变量。",
      assigneeId: coach.id,
      auditorId: auditor.id,
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 0,
      acceptanceCriteria: "讲清闭包能捕获变量的原因。",
      acceptanceChecklist: [
        { type: "judge", value: CRITERION, required: true },
      ],
      estimateMin: 30,
      template: "learning",
    },
    USER,
  );
  // learning 模板的 topicKey 由排期命令回写，createTask 不认这一列。
  await db.update(tasks).set({ topicKey: "闭包" }).where(eq(tasks.id, task.id));
  await runTask(task.id, USER);

  const judge: JudgeFn = async () => ({
    status: "success",
    text: JSON.stringify({
      verdicts: [
        { criterion: CRITERION, pass: true, reason: "答案解释了词法环境" },
      ],
    }),
    model: "fake-judge",
    tokensIn: 120,
    tokensOut: 40,
  });
  const result = await auditTask(task.id, USER, { judge });
  expect(result.decision).toBe("accepted");

  await applyOverride({
    userId: USER,
    key: "learning.nextTask.minWords",
    value: 40,
  });

  return task.id;
}

const rowsFor = async (userId: string) => ({
  users: (await db.select().from(users).where(eq(users.id, userId))).length,
  agents: (
    await db.select().from(agents).where(eq(agents.userId, userId))
  ).length,
  topics: (
    await db.select().from(learningTopics).where(eq(learningTopics.userId, userId))
  ).length,
  mastery: (
    await db
      .select()
      .from(learningMastery)
      .where(eq(learningMastery.userId, userId))
  ).length,
  attempts: (
    await db
      .select()
      .from(learningAttempts)
      .where(eq(learningAttempts.userId, userId))
  ).length,
  overrides: (
    await db
      .select()
      .from(policyOverrides)
      .where(eq(policyOverrides.userId, userId))
  ).length,
});

beforeEach(async () => {
  await resetDb();
  await seedUser(USER);
});

describe("删除账号必须先清掉学习与策略数据", () => {
  it("有学习历史与策略覆盖的账号能被删干净", async () => {
    await seedLearningHistory();

    // 先证明 fixture 真的产生了会被外键挡住的行；否则下面的断言什么都没测到。
    const seeded = await rowsFor(USER);
    expect(seeded.topics).toBeGreaterThan(0);
    expect(seeded.mastery).toBeGreaterThan(0);
    expect(seeded.attempts).toBeGreaterThan(0);
    expect(seeded.overrides).toBeGreaterThan(0);

    // 删号不抛错：learning_attempts.artifact_id / task_id 没有 CASCADE，
    // 之前这里会在 delete(artifacts) 处撞外键，接口直接 500。
    await expect(deleteAccount(USER)).resolves.toBeUndefined();

    const after = await rowsFor(USER);
    expect(after).toEqual({
      users: 0,
      agents: 0,
      topics: 0,
      mastery: 0,
      attempts: 0,
      overrides: 0,
    });

    // 别的用户的数据不受牵连。
    const demo = await rowsFor("usr_zhen");
    expect(demo.users).toBe(1);
    expect(demo.agents).toBe(7);
  });

  it("NDJSON 导出也带上这四张表（能删就得能带走）", async () => {
    await seedLearningHistory();

    const lines: Array<Record<string, unknown>> = [];
    for await (const line of exportAccountNdjson(USER)) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    const dumped = new Map(
      lines
        .filter((line) => line.kind === "rows")
        .map((line) => [String(line.table), line.rows as unknown[]]),
    );

    // /api/export 是并列的第二套导出实现：只改 exportAccount 的话，
    // 用户能删干净却带不走自己的学习历史。
    expect(dumped.get("learningTopics")?.length).toBeGreaterThan(0);
    expect(dumped.get("learningMastery")?.length).toBeGreaterThan(0);
    expect(dumped.get("learningAttempts")?.length).toBeGreaterThan(0);
    expect(dumped.get("policyOverrides")?.length).toBeGreaterThan(0);
  });

  it("没有学习数据的老账号照常能删（回归：新增的删除不引入顺序问题）", async () => {
    await setupWorkspace({ userId: USER, timezone: "Asia/Shanghai" });

    const seeded = await rowsFor(USER);
    expect(seeded.agents).toBe(7);
    expect(seeded.topics).toBe(0);
    expect(seeded.attempts).toBe(0);
    expect(seeded.overrides).toBe(0);

    await expect(deleteAccount(USER)).resolves.toBeUndefined();

    const after = await rowsFor(USER);
    expect(after.users).toBe(0);
    expect(after.agents).toBe(0);
  });
});
