import { beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { agents, auditEvents, outbox, tasks } from "@/lib/db/schema";
import type { AcceptanceItem } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { auditTask, createTask, runTask } from "@/server/services/engine";
import { resetDb } from "../helpers/db";

// "没有结论"不等于"通过"。这组用例把三种结论分别钉在状态上：
// 通过的写 accepted、判否的写 rejected、没人给出结论的必须停在 needs_review。
// 从前第二种和第三种都是 accepted，等于让 Auditor 替一次没发生的判定签字。

async function setupTask(checklist?: AcceptanceItem[]): Promise<string> {
  const task = await createTask(
    {
      title: "整理本周会议要点",
      description: "把三次会议的要点整理成一页纸，每条不超过 50 字。",
      assigneeId: "ag_coach",
      auditorId: "ag_auditor",
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 0,
      acceptanceCriteria: "三条会议要点。",
      // 不传就是"没有验收清单"：这个字段为 undefined 时 createTask 存 null。
      ...(checklist ? { acceptanceChecklist: checklist } : {}),
      estimateMin: 20,
    },
    DEMO_USER_ID,
  );
  await runTask(task.id, DEMO_USER_ID);
  return task.id;
}

async function taskRow(taskId: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return row;
}

async function latestAuditAction(taskId: string) {
  const [event] = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.target, taskId))
    .orderBy(desc(auditEvents.seq))
    .limit(1);
  return event;
}

async function executorCounters() {
  const [row] = await db
    .select({
      successCount: agents.successCount,
      failCount: agents.failCount,
      trustScore: agents.trustScore,
      rejectStreak: agents.rejectStreak,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.id, "ag_coach"));
  return row;
}

beforeEach(async () => {
  await resetDb();
});

describe("审计没有给出结论时停在 needs_review", () => {
  it("没有验收清单的任务：产物非空也只停在待你判定，不再直接 accepted", async () => {
    const taskId = await setupTask();

    const result = await auditTask(taskId, DEMO_USER_ID);

    expect(result.decision).toBe("needs_review");
    expect(result.verdict).toBe("needs_review");
    expect(result.reason).toContain("没有验收清单");
    expect(result.reason).toContain("没有结论");

    const row = await taskRow(taskId);
    expect(row.status).toBe("needs_review");
    expect(row.acceptedAt).toBeNull();
    // 报告里那条人工待判项仍在：它解释的就是"为什么没有结论"。
    expect(row.acceptanceReport?.[0].item.type).toBe("manual");
    expect(row.acceptanceReport?.[0].undetermined).toBe(true);

    // 审计行不能写成 audit.accept，否则日志读起来像验收通过。
    const event = await latestAuditAction(taskId);
    expect(event.action).toBe("audit.needs_review");
    const after = event.after as {
      verdict?: string;
      artifactId?: string | null;
      pending?: unknown[];
    };
    expect(after.verdict).toBe("needs_review");
    expect(after.artifactId).toBeTruthy();
    // 未判定条目的摘要必须落在审计行里：事后要能看出到底哪一条没人判。
    expect(after.pending?.length).toBe(1);
  });

  it("清单里有 required 人工项 → needs_review", async () => {
    const taskId = await setupTask([
      { type: "min_words", value: 1, required: true },
      { type: "manual", note: "三条要点是否真的来自会议记录", required: true },
    ]);

    const result = await auditTask(taskId, DEMO_USER_ID);

    expect(result.decision).toBe("needs_review");
    expect(result.reason).toContain("人工判定");
    const row = await taskRow(taskId);
    expect(row.status).toBe("needs_review");
    // 确定性的那条是通过的：待人判定的是另一条，两者不能混为一谈。
    expect(row.acceptanceReport?.[0].passed).toBe(true);
    expect(row.acceptanceReport?.[1].undetermined).toBe(true);
  });

  it("待判定会发出一条 review 通知，而不是驳回", async () => {
    const taskId = await setupTask();

    await auditTask(taskId, DEMO_USER_ID);

    const rows = await db.select().from(outbox).where(eq(outbox.targetId, taskId));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("review");
    expect(rows[0].subject).toContain("待你判定");
    expect(rows[0].href).toBe(`/tasks/${taskId}`);
    // 通知正文必须把"没有结论"和"执行有问题"分开，否则用户会去修一个没坏的东西。
    expect(rows[0].body).toContain("不是驳回");
    expect(rows[0].body).toContain("不会扣执行者的信任分");
  });

  it("有结论的验收不发 review 通知", async () => {
    const taskId = await setupTask([{ type: "min_words", value: 1, required: true }]);

    await auditTask(taskId, DEMO_USER_ID);

    const rows = await db.select().from(outbox).where(eq(outbox.targetId, taskId));
    expect(rows).toEqual([]);
  });

  it("所有 required 项都通过 → accepted", async () => {
    const taskId = await setupTask([{ type: "min_words", value: 1, required: true }]);

    const result = await auditTask(taskId, DEMO_USER_ID);

    expect(result.decision).toBe("accepted");
    expect(result.verdict).toBe("pass");
    const row = await taskRow(taskId);
    expect(row.status).toBe("accepted");
    expect(row.acceptedAt).not.toBeNull();
    expect((await latestAuditAction(taskId)).action).toBe("audit.accept");
  });

  it("required 项明确失败 → rejected", async () => {
    const taskId = await setupTask([{ type: "min_words", value: 5000, required: true }]);

    const result = await auditTask(taskId, DEMO_USER_ID);

    expect(result.decision).toBe("rejected");
    expect(result.verdict).toBe("fail");
    const row = await taskRow(taskId);
    expect(row.status).toBe("rejected");
    expect(row.acceptedAt).toBeNull();
    expect((await latestAuditAction(taskId)).action).toBe("audit.reject");
  });

  it("needs_review 不动执行者的 successCount / failCount / trustScore / rejectStreak", async () => {
    const before = await executorCounters();

    const taskId = await setupTask([
      { type: "min_words", value: 1, required: true },
      { type: "manual", note: "要点是否覆盖三次会议", required: true },
    ]);
    const result = await auditTask(taskId, DEMO_USER_ID);
    expect(result.decision).toBe("needs_review");

    const after = await executorCounters();
    // 没有结论就不能算成功（会让人靠"未判定的产物"晋升），
    // 也不能算失败（会在没人判过的情况下扣信任分、推高连续驳回）。
    expect(after).toEqual(before);

    // 同一组计数确实在这条路径上会被写：换一个明确失败的同类任务，
    // failCount 必须 +1。否则上面那条 toEqual 可能只是断言了一个没人写的行。
    const failedTaskId = await setupTask([
      { type: "min_words", value: 5000, required: true },
    ]);
    await auditTask(failedTaskId, DEMO_USER_ID);
    const afterFailure = await executorCounters();
    expect(afterFailure.failCount).toBe(before.failCount + 1);
    expect(afterFailure.rejectStreak).toBe(before.rejectStreak + 1);
  });
});
