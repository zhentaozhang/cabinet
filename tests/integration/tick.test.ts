import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  approvals,
  auditEvents,
  dissents,
  idempotencyKeys,
  outbox,
  rateLimits,
  runJobs,
  tasks,
} from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import {
  archiveOldOutbox,
  closeExpiredPeriods,
  pruneIdempotencyKeys,
  pruneRateLimits,
  runSteps,
  runTick,
  settleDueDissents,
  tickSteps,
} from "@/server/jobs/maintenance";
import { MAX_CLAIM_ATTEMPTS } from "@/server/services/commands/tasks/jobs";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

async function taskStatus(taskId: string): Promise<string | undefined> {
  const [task] = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  return task?.status;
}

function step(report: { steps: { step: string }[] }, name: string) {
  return report.steps.find((entry) => entry.step === name) as {
    step: string;
    ok: boolean;
    count: number;
    error?: string;
    detail?: Record<string, unknown>;
  };
}

describe("tick: 过期审批", () => {
  it("把到期的 pending 审批置 expired，并把任务退回 planned", async () => {
    // The seed ships appr_booking pending with a deadline tomorrow, and
    // tsk_booking parked in awaiting_approval — exactly the shape a human
    // abandoning the approval leaves behind.
    expect(await taskStatus("tsk_booking")).toBe("awaiting_approval");
    await db
      .update(approvals)
      .set({ expiresAt: hoursAgo(1) })
      .where(eq(approvals.id, "appr_booking"));

    const report = await runTick();
    const expired = step(report, "expireStaleApprovals");

    expect(expired.ok).toBe(true);
    expect(expired.count).toBe(1);
    expect(expired.detail).toMatchObject({ tasksRewound: 1 });

    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, "appr_booking"));
    expect(approval.status).toBe("expired");
    expect(approval.decidedAt).not.toBeNull();
    expect(await taskStatus("tsk_booking")).toBe("planned");

    const audit = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, DEMO_USER_ID),
          eq(auditEvents.action, "approval.expire"),
          eq(auditEvents.target, "appr_booking"),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0].after).toMatchObject({ status: "expired", taskRewound: true });
  });

  it("未到期的审批不动，任务仍停在 awaiting_approval", async () => {
    const report = await runTick();
    expect(step(report, "expireStaleApprovals").count).toBe(0);

    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, "appr_booking"));
    expect(approval.status).toBe("pending");
    expect(await taskStatus("tsk_booking")).toBe("awaiting_approval");
  });
});

describe("tick: 租约耗尽", () => {
  it("把耗尽重试次数的作业置 failed，未耗尽的保持 queued", async () => {
    await db.insert(runJobs).values([
      {
        id: "job_spent",
        userId: DEMO_USER_ID,
        taskId: "tsk_quiz",
        status: "queued",
        attempts: MAX_CLAIM_ATTEMPTS,
      },
      {
        id: "job_fresh",
        userId: DEMO_USER_ID,
        taskId: "tsk_research",
        status: "queued",
        attempts: 1,
      },
    ]);

    const report = await runTick();
    expect(step(report, "failExhaustedJobs").count).toBe(1);

    const [spent] = await db
      .select()
      .from(runJobs)
      .where(eq(runJobs.id, "job_spent"));
    expect(spent.status).toBe("failed");
    expect(spent.lastError).toContain("超过最大尝试次数");
    expect(spent.finishedAt).not.toBeNull();

    const [fresh] = await db
      .select()
      .from(runJobs)
      .where(eq(runJobs.id, "job_fresh"));
    expect(fresh.status).toBe("queued");
  });
});

describe("tick: TTL", () => {
  it("删掉 24h 前的限流窗口，保留仍在用的窗口", async () => {
    await db.insert(rateLimits).values([
      {
        id: "rl_old",
        userId: DEMO_USER_ID,
        action: "task-run",
        windowStart: hoursAgo(30),
        count: 9,
      },
      {
        id: "rl_fresh",
        userId: DEMO_USER_ID,
        action: "task-run",
        windowStart: hoursAgo(1),
        count: 2,
      },
    ]);

    expect(await pruneRateLimits()).toEqual({ deleted: 1 });

    const rows = await db.select().from(rateLimits);
    expect(rows.map((row) => row.id)).toEqual(["rl_fresh"]);
  });

  it("删掉已过期的幂等键，保留还在重放窗口里的", async () => {
    await db.insert(idempotencyKeys).values([
      {
        id: "idem_old",
        userId: DEMO_USER_ID,
        key: "k-old",
        endpoint: "/api/tasks",
        requestHash: "hash-1",
        expiresAt: hoursAgo(2),
      },
      {
        id: "idem_live",
        userId: DEMO_USER_ID,
        key: "k-live",
        endpoint: "/api/tasks",
        requestHash: "hash-2",
        expiresAt: hoursAgo(-2),
      },
    ]);

    expect(await pruneIdempotencyKeys()).toEqual({ deleted: 1 });

    const rows = await db.select().from(idempotencyKeys);
    expect(rows.map((row) => row.id)).toEqual(["idem_live"]);
  });

  it("只删已收尾（sent/skipped）的老通知", async () => {
    const base = {
      userId: DEMO_USER_ID,
      kind: "budget",
      subject: "s",
      body: "b",
      targetType: "task",
      targetId: "tsk_quiz",
    };
    await db.insert(outbox).values([
      { ...base, id: "ob_sent_old", dedupeKey: "d1", status: "sent", createdAt: daysAgo(40) },
      { ...base, id: "ob_skipped_old", dedupeKey: "d2", status: "skipped", createdAt: daysAgo(40) },
      { ...base, id: "ob_sent_new", dedupeKey: "d3", status: "sent", createdAt: daysAgo(1) },
      { ...base, id: "ob_pending_old", dedupeKey: "d4", status: "pending", createdAt: daysAgo(40) },
      { ...base, id: "ob_sending_old", dedupeKey: "d5", status: "sending", createdAt: daysAgo(40) },
      { ...base, id: "ob_failed_old", dedupeKey: "d6", status: "failed", createdAt: daysAgo(40) },
    ]);

    expect(await archiveOldOutbox()).toEqual({ deleted: 2 });

    const rows = await db.select().from(outbox);
    expect(rows.map((row) => row.id).sort()).toEqual([
      "ob_failed_old",
      "ob_pending_old",
      "ob_sending_old",
      "ob_sent_new",
    ]);
  });
});

describe("tick: 可重复执行", () => {
  it("连跑两次，第二次什么都不改", async () => {
    await db
      .update(approvals)
      .set({ expiresAt: hoursAgo(1) })
      .where(eq(approvals.id, "appr_booking"));
    await db.insert(rateLimits).values({
      id: "rl_once",
      userId: DEMO_USER_ID,
      action: "task-run",
      windowStart: hoursAgo(48),
      count: 3,
    });
    await db.insert(idempotencyKeys).values({
      id: "idem_once",
      userId: DEMO_USER_ID,
      key: "k-once",
      endpoint: "/api/tasks",
      requestHash: "hash-once",
      expiresAt: hoursAgo(3),
    });

    const first = await runTick();
    const second = await runTick();

    // The first pass had work; the second must find none of it left.
    expect(step(first, "expireStaleApprovals").count).toBe(1);
    expect(step(first, "pruneRateLimits").count).toBe(1);
    expect(step(first, "pruneIdempotencyKeys").count).toBe(1);

    for (const entry of second.steps) {
      expect(entry.ok).toBe(true);
      expect(entry.count).toBe(0);
    }
    expect(second.ok).toBe(true);
    expect(second.allFailed).toBe(false);

    // Nothing re-expired, nothing re-audited.
    const audit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "approval.expire"));
    expect(audit).toHaveLength(1);
  });
});

describe("tick: 一步失败不阻断其余步骤", () => {
  it("抛错的那步记为失败，后面的步骤照常执行", async () => {
    await db.insert(rateLimits).values({
      id: "rl_after_failure",
      userId: DEMO_USER_ID,
      action: "task-run",
      windowStart: hoursAgo(48),
      count: 1,
    });

    // Recovery is replaced by a guaranteed failure — the shape of a broken
    // sweep (locked table, bad migration) in front of the TTL passes.
    const steps = tickSteps();
    steps[0] = {
      name: "recoverStaleRuns",
      run: async () => {
        throw new Error("模拟失败：恢复步骤抛错");
      },
    };

    const report = await runSteps(steps);

    expect(report.steps[0]).toMatchObject({
      step: "recoverStaleRuns",
      ok: false,
      count: 0,
      error: "模拟失败：恢复步骤抛错",
    });
    // Every later step still ran, and the prune really reached the database.
    const pruned = step(report, "pruneRateLimits");
    expect(pruned.ok).toBe(true);
    expect(pruned.count).toBe(1);
    expect(await db.select().from(rateLimits)).toHaveLength(0);

    expect(report.failed).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.allFailed).toBe(false);
  });

  it("所有步骤都失败才算整体失败（脚本据此返回非 0）", async () => {
    const report = await runSteps([
      {
        name: "pruneRateLimits",
        run: async () => {
          throw new Error("connection refused");
        },
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.allFailed).toBe(true);
  });

  it("把窗口已过的异议判掉，窗口未过的留着", async () => {
    // `evaluateDissents` used to be reachable only from /api/reflect, so a
    // dissent nobody clicked stayed pending forever and the metric it promised
    // to watch was never read.
    await db.insert(dissents).values([
      {
        id: "dis_due",
        userId: DEMO_USER_ID,
        councilId: "ccl_course",
        agentId: "ag_critic",
        warning: "这周会有任务失败。",
        condition: {
          metric: "task_failure_count",
          operator: "==",
          threshold: 0,
          windowDays: 1,
        },
        status: "pending",
        evidence: [],
        createdAt: daysAgo(3),
      },
      {
        id: "dis_open",
        userId: DEMO_USER_ID,
        councilId: "ccl_course",
        agentId: "ag_critic",
        warning: "窗口还没到，别急着判。",
        condition: {
          metric: "task_failure_count",
          operator: "==",
          threshold: 0,
          windowDays: 7,
        },
        status: "pending",
        evidence: [],
        createdAt: new Date(),
      },
    ]);

    const result = await settleDueDissents();
    expect(result.users).toBe(1);
    expect(result.vindicated + result.invalidated).toBe(1);
    expect(result.failed).toBe(0);

    const rows = await db.select().from(dissents);
    expect(rows.find((row) => row.id === "dis_due")?.status).toBe("vindicated");
    expect(rows.find((row) => row.id === "dis_open")?.status).toBe("pending");
  });

  it("把异议判定挂进 tick 的固定步骤", async () => {
    expect(tickSteps().map((entry) => entry.name)).toContain(
      "settleDueDissents",
    );
  });

  it("关掉已经过去的预算周期，本周期不动", async () => {
    // `closed_at` 只被准入路径读取（"该预算周期已关闭。"），从来没有写入方：
    // 一周结束时没有人做这个动作，于是"这周多少钱算完"永远没有答案。
    const now = new Date();
    const weekStart = new Date(now.getTime() - 7 * 86_400_000);
    await db.insert(agentBudgetPeriods).values([
      {
        id: "bpd_past_week",
        userId: DEMO_USER_ID,
        agentId: "ag_coach",
        timezone: "Asia/Shanghai",
        periodStart: new Date(weekStart.getTime() - 7 * 86_400_000),
        periodEnd: weekStart,
        limitCents: 1200,
        settledCents: 42,
      },
      {
        id: "bpd_current_week",
        userId: DEMO_USER_ID,
        agentId: "ag_coach",
        timezone: "Asia/Shanghai",
        periodStart: weekStart,
        periodEnd: new Date(now.getTime() + 7 * 86_400_000),
        limitCents: 1200,
      },
    ]);

    expect((await closeExpiredPeriods(now)).closed).toBe(1);

    const rows = await db.select().from(agentBudgetPeriods);
    const past = rows.find((row) => row.id === "bpd_past_week");
    const current = rows.find((row) => row.id === "bpd_current_week");
    expect(past?.closedAt).not.toBeNull();
    expect(current?.closedAt).toBeNull();
    // 已关闭的行仍是账本：不清零、不删除。
    expect(past?.settledCents).toBe(42);

    expect((await closeExpiredPeriods(now)).closed).toBe(0);
    expect(tickSteps().map((entry) => entry.name)).toContain(
      "closeExpiredPeriods",
    );
  });
});

