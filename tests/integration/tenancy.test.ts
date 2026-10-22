import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  agents,
  approvals,
  councils,
  insights,
  tasks,
  users,
} from "@/lib/db/schema";
import {
  applyInsight,
  auditTask,
  createTask,
  decideApproval,
  decideCouncil,
  getAgentData,
  getTaskData,
  runTask,
  setAutonomy,
  updateAgent,
} from "@/lib/engine";
import { DEMO_USER_ID } from "@/lib/demo";
import { NotFoundError, ValidationError } from "@/lib/domain/errors";
import { resetDb } from "../helpers/db";

const OTHER = "usr_other";

async function seedOtherWorkspace() {
  await db.insert(users).values({
    id: OTHER,
    email: "other@cabinet.local",
    name: "Other",
    emailVerified: true,
    timezone: "Asia/Shanghai",
    updatedAt: new Date(),
  });
  await db.insert(agents).values({
    id: "ag_other",
    userId: OTHER,
    role: "coach",
    name: "Other Coach",
    title: "Coach",
    avatar: "OC",
    charter:
      "我属于另一个用户，任何跨用户访问都应该返回 404，而不是泄露我的存在。",
    objective: "学习",
    tools: [],
    memoryScope: [],
    status: "active",
    autonomyLevel: 1,
    trustScore: 50,
    lifecycleStage: "active",
    budgetCents: 1000,
    spentCents: 0,
    budgetPeriodStart: new Date(),
  });
  await db.insert(tasks).values({
    id: "tsk_other",
    userId: OTHER,
    title: "Other task",
    description: "跨用户任务",
    assigneeId: "ag_other",
    auditorId: "ag_auditor",
    status: "planned",
    acceptanceCriteria: "有产物",
    estimateMin: 25,
    actionType: "internal",
    resource: "task",
    estimatedCostCents: 10,
    createdBy: "user",
  });
  await db.insert(insights).values({
    id: "ins_other",
    userId: OTHER,
    claim: "Other insight",
    rationale: "Other rationale",
    confidence: 0.5,
    evidence: [],
    proposedChange: { type: "none" },
    status: "proposed",
  });
  await db.insert(approvals).values({
    id: "appr_other",
    userId: OTHER,
    taskId: "tsk_other",
    action: "external",
    payload: {},
    status: "pending",
  });
  await db.insert(councils).values({
    id: "ccl_other",
    userId: OTHER,
    topic: "Other council",
    trigger: "test",
    status: "open",
    memo: "test",
  });
}

beforeEach(async () => {
  await resetDb();
  await seedOtherWorkspace();
});

describe("tenant isolation", () => {
  it("does not read another user's task or agent", async () => {
    expect(await getTaskData("tsk_other", DEMO_USER_ID)).toBeNull();
    expect(await getAgentData("ag_other", DEMO_USER_ID)).toBeNull();
  });

  it("does not run another user's task", async () => {
    await expect(runTask("tsk_other", DEMO_USER_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("does not audit another user's task", async () => {
    await expect(auditTask("tsk_other", DEMO_USER_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("does not apply another user's insight", async () => {
    await expect(
      applyInsight("ins_other", "accept", DEMO_USER_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not change another user's agent", async () => {
    await expect(
      setAutonomy("ag_other", 3, DEMO_USER_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      updateAgent("ag_other", { status: "paused" }, DEMO_USER_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not decide another user's approval or council", async () => {
    await expect(
      decideApproval("appr_other", "approve", "test", DEMO_USER_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      decideCouncil("ccl_other", "approve", "test", DEMO_USER_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not assign a task to another user's agent", async () => {
    await expect(
      createTask(
        {
          title: "Cross tenant",
          description: "should fail",
          assigneeId: "ag_other",
          auditorId: "ag_auditor",
          actionType: "internal",
          resource: "task",
          estimatedCostCents: 0,
          acceptanceCriteria: "none",
          estimateMin: 25,
        },
        DEMO_USER_ID,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
