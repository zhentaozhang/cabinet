import { DEMO_USER_ID } from "@/lib/demo";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, councils, goals, tasks } from "@/lib/db/schema";
import {
  createCouncil,
  createGoal,
  createTask,
  promoteSuggestion,
  runTask,
  updateAgent,
} from "@/server/services/engine";
import { ConflictError, ValidationError } from "@/lib/domain/errors";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("agent management", () => {
  it("pauses and resumes an agent", async () => {
    await updateAgent("ag_coach", { status: "paused" }, DEMO_USER_ID);
    let [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_coach"));
    expect(agent.status).toBe("paused");

    await updateAgent("ag_coach", { status: "active" }, DEMO_USER_ID);
    [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_coach"));
    expect(agent.status).toBe("active");
  });

  it("refuses to retire an agent with open tasks", async () => {
    await expect(
      updateAgent("ag_coach", { status: "retired" }, DEMO_USER_ID),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("validates charter length", async () => {
    await expect(
      updateAgent("ag_coach", { charter: "too short" }, DEMO_USER_ID),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("updates a valid charter and budget", async () => {
    await updateAgent("ag_coach", {
      charter:
        "我负责让你真的学会，而不是让任务显示完成。我会根据你的错误模式调整难度。",
      budgetCents: 2000,
    }, DEMO_USER_ID);
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_coach"));
    expect(agent.budgetCents).toBe(2000);
    expect(agent.charter).toContain("错误模式");
  });
});

describe("goal and task creation", () => {
  it("creates a goal", async () => {
    const goal = await createGoal(
      {
        title: "准备系统设计面试",
        why: "换工作",
        target: "完成 20 道系统设计题",
        horizon: "8 weeks",
        domain: "learning",
      },
      DEMO_USER_ID,
    );
    const [row] = await db.select().from(goals).where(eq(goals.id, goal.id));
    expect(row.title).toBe("准备系统设计面试");
  });

  it("rejects self-audit task creation", async () => {
    await expect(
      createTask(
        {
          title: "测试任务",
          description: "描述",
          assigneeId: "ag_auditor",
          auditorId: "ag_auditor",
          actionType: "internal",
          resource: "task",
          estimatedCostCents: 10,
          acceptanceCriteria: "有产物",
          estimateMin: 25,
        },
        DEMO_USER_ID,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("creates a task with explicit policy fields", async () => {
    const task = await createTask(
      {
        title: "写一页 RAG 复盘",
        description: "总结本周的检索实验。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 60,
        acceptanceCriteria: "至少 300 字，包含 1 个失败案例。",
        estimateMin: 25,
      },
      DEMO_USER_ID,
    );
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.status).toBe("planned");
    expect(row.actionType).toBe("internal");
    expect(row.estimatedCostCents).toBe(60);
  });
});

describe("L1 suggestions", () => {
  it("suggests at L1 and promotes to planned", async () => {
    await db
      .update(agents)
      .set({ autonomyLevel: 1 })
      .where(eq(agents.id, "ag_coach"));

    const result = await runTask("tsk_read", DEMO_USER_ID);
    expect(result).toMatchObject({ suggested: true });

    let [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_read"));
    expect(task.status).toBe("suggested");

    await promoteSuggestion("tsk_read", DEMO_USER_ID);
    [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_read"));
    expect(task.status).toBe("planned");
  });
});

describe("council creation", () => {
  it("creates an open council", async () => {
    const council = await createCouncil(
      {
        topic: "要不要换一个更贵但更快的模型？",
        trigger: "成本差异 > 2x",
      },
      DEMO_USER_ID,
    );
    const [row] = await db
      .select()
      .from(councils)
      .where(eq(councils.id, council.id));
    expect(row.status).toBe("open");
  });
});
