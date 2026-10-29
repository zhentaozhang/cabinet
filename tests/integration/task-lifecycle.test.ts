import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { approvals, auditEvents, tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { createTask } from "@/server/services/commands/tasks/create";
import { decideApproval } from "@/server/services/commands/tasks/approvals";
import { markTaskDone } from "@/server/services/commands/tasks/done";
import { runTask } from "@/server/services/commands/tasks/run";
import { ConflictError } from "@/lib/domain/errors";
import { pendingApprovalFor } from "@/lib/presentation/task-view";
import { getTaskData } from "@/server/services/queries/task";
import { resetDb } from "../helpers/db";

async function externalTask() {
  return createTask(
    {
      title: "预约外部课程",
      description: "需要审批的外部动作",
      assigneeId: "ag_coach",
      auditorId: "ag_auditor",
      actionType: "external",
      resource: "calendar",
      estimatedCostCents: 1000,
      acceptanceCriteria: "确认时间、费用、取消政策。",
      estimateMin: 10,
    },
    DEMO_USER_ID,
  );
}

beforeEach(async () => {
  await resetDb();
});

describe("task approval lifecycle", () => {
  it("moves a newly planned external task into approval", async () => {
    const task = await externalTask();
    const result = await runTask(task.id, DEMO_USER_ID);
    expect("requiresApproval" in result && result.requiresApproval).toBe(true);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.status).toBe("awaiting_approval");
  });

  it("stores a payload the UI can actually render", async () => {
    const task = await externalTask();
    await runTask(task.id, DEMO_USER_ID);

    const [approval] = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.taskId, task.id),
          eq(approvals.status, "pending"),
        ),
      );
    expect(approval.payload.title).toBe("预约外部课程");
    expect(approval.payload.reason).toContain("L2");
    expect(approval.payload.estimatedCostCents).toBe(1000);
  });

  it("allows a rejected external task to request a fresh approval", async () => {
    const task = await externalTask();
    const first = await runTask(task.id, DEMO_USER_ID);
    expect("requiresApproval" in first).toBe(true);

    await decideApproval(
      (first as { approvalId: string }).approvalId,
      "approve",
      "ok",
      DEMO_USER_ID,
    );
    await runTask(task.id, DEMO_USER_ID);

    await db
      .update(tasks)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(eq(tasks.id, task.id));

    const second = await runTask(task.id, DEMO_USER_ID);
    expect("requiresApproval" in second).toBe(true);
    expect((second as { approvalId: string }).approvalId).not.toBe(
      (first as { approvalId: string }).approvalId,
    );
  });

  it("keeps the spent approval of the first attempt behind the one still waiting", async () => {
    // 页面原来把 `approvals[0]` 印成「待审批动作」。第二次审批请求之后表里有
    // 两行：第一次运行花掉的 approved，和这次真正在等你的 pending。查询没有
    // ORDER BY 时先返回哪一行全看物理行序，横幅就会念上一次的动作与旧理由。
    const task = await externalTask();
    const first = await runTask(task.id, DEMO_USER_ID);
    await decideApproval(
      (first as { approvalId: string }).approvalId,
      "approve",
      "ok",
      DEMO_USER_ID,
    );
    await runTask(task.id, DEMO_USER_ID);
    await db
      .update(tasks)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(eq(tasks.id, task.id));

    const second = await runTask(task.id, DEMO_USER_ID);
    const pendingId = (second as { approvalId: string }).approvalId;

    const data = await getTaskData(task.id, DEMO_USER_ID);
    expect(data?.approvals).toHaveLength(2);
    expect(data?.approvals[0].id).toBe(pendingId);
    expect(pendingApprovalFor(data!.approvals)?.id).toBe(pendingId);
    expect(
      data?.approvals.filter((row) => row.status === "approved"),
    ).toHaveLength(1);
  });
  it("expires an overdue approval and returns the task to planned", async () => {
    const task = await externalTask();
    const result = await runTask(task.id, DEMO_USER_ID);
    const approvalId = (result as { approvalId: string }).approvalId;

    await db
      .update(approvals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(approvals.id, approvalId));

    await expect(
      decideApproval(approvalId, "approve", "late", DEMO_USER_ID),
    ).rejects.toBeInstanceOf(ConflictError);

    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(approval.status).toBe("expired");
    expect(row.status).toBe("planned");
  });

  it("allows accepted -> done and audits it", async () => {
    const task = await createTask(
      {
        title: "内部任务",
        description: "完成后标记 done",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        acceptanceCriteria: "有产物",
        estimateMin: 10,
      },
      DEMO_USER_ID,
    );
    await db
      .update(tasks)
      .set({ status: "accepted" })
      .where(eq(tasks.id, task.id));

    await markTaskDone(task.id, DEMO_USER_ID);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.status).toBe("done");
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, DEMO_USER_ID),
          eq(auditEvents.action, "task.done"),
          eq(auditEvents.target, task.id),
        ),
      );
    expect(audit).toBeDefined();
  });
});
