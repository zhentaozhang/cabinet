import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  auditEvents,
  checkins,
  tasks,
  userActions,
  users,
} from "@/lib/db/schema";
import { localDateKey } from "@/lib/domain/time";
import { getPolicyConfig } from "@/lib/policy/config";
import { getWeeklyMetrics } from "@/server/services/queries/metrics";
import { resetDb } from "../helpers/db";

const TZ = "Asia/Shanghai";

async function createUser(id: string) {
  await db.insert(users).values({
    id,
    email: `${id}@cabinet.local`,
    name: id,
    emailVerified: true,
    timezone: TZ,
    updatedAt: new Date(),
  });
}

beforeEach(async () => {
  await resetDb();
});

describe("weekly metrics sample semantics", () => {
  it("reports null instead of zero when there is no sample", async () => {
    const userId = "usr_metrics_empty";
    await createUser(userId);

    const metrics = await getWeeklyMetrics(userId);

    expect(metrics.adherence).toBeNull();
    expect(metrics.auditRejectRate).toBeNull();
    expect(metrics.retestPassRate).toBeNull();
    expect(metrics.managementMinutes).toBeNull();
    expect(metrics.managementMinutesSource).toBe("estimated");
    expect(metrics.aao).toBe(0);
    expect(metrics.studyMinutes).toBe(0);
    expect(metrics.learningTasks).toBe(0);
    // Money crosses the wire in cents, exactly like runs.costCents.
    expect(metrics.costCents).toBe(0);
    expect(metrics.sample).toEqual({
      planned: 0,
      completed: 0,
      accepts: 0,
      rejects: 0,
      // 一条待判定都没有：0 是真实计数（而不是"没样本"），因为它统计的是
      // 此刻还有多少条验收停在你这里，没有就是 0。
      pendingReview: 0,
    });
  });

  it("keeps real values and legitimate zeros when samples exist", async () => {
    const userId = "usr_metrics_mixed";
    await createUser(userId);

    const now = new Date();
    await db.insert(tasks).values([
      {
        id: "tsk_metrics_planned",
        userId,
        title: "planned",
        description: "d",
        status: "planned",
        dueAt: now,
        acceptanceCriteria: "c",
      },
      {
        id: "tsk_metrics_accepted",
        userId,
        title: "accepted",
        description: "d",
        status: "accepted",
        dueAt: now,
        acceptanceCriteria: "c",
      },
      {
        id: "tsk_metrics_retest_pass",
        userId,
        title: "retest pass",
        description: "d",
        status: "accepted",
        template: "learning_retest",
        acceptanceCriteria: "c",
      },
      {
        id: "tsk_metrics_retest_fail",
        userId,
        title: "retest fail",
        description: "d",
        status: "rejected",
        template: "learning_retest",
        acceptanceCriteria: "c",
      },
      // 待判定的审计行必须指向一条真实任务：这条数字说的是"现在还停着"，
      // 没有任务行就无从判断它是否还在等（见下一条用例）。
      {
        id: "tsk_metrics_pending",
        userId,
        title: "pending",
        description: "d",
        status: "needs_review",
        acceptanceCriteria: "c",
      },
    ]);

    await db.insert(auditEvents).values([
      {
        id: "aud_metrics_accept",
        userId,
        actor: "agent",
        action: "audit.accept",
        target: "tsk_metrics_accepted",
        hash: "hash-a",
      },
      {
        id: "aud_metrics_reject_1",
        userId,
        actor: "agent",
        action: "audit.reject",
        target: "tsk_metrics_retest_fail",
        hash: "hash-b",
      },
      {
        id: "aud_metrics_reject_2",
        userId,
        actor: "agent",
        action: "audit.reject",
        target: "tsk_metrics_retest_fail",
        hash: "hash-c",
      },
      {
        id: "aud_metrics_needs_review",
        userId,
        actor: "agent",
        action: "audit.needs_review",
        target: "tsk_metrics_pending",
        hash: "hash-d",
      },
    ]);

    await db.insert(userActions).values({
      id: "ua_metrics",
      userId,
      action: "approve",
      durationMs: 90_000,
    });

    await db.insert(checkins).values({
      id: "chk_metrics",
      userId,
      date: localDateKey(now, TZ),
      energy: 3,
      mood: 3,
      completed: [],
      studyMinutes: 0,
      recallScore: 0.8,
      errorTags: [],
    });

    const metrics = await getWeeklyMetrics(userId);

    expect(metrics.adherence).toBe(50);
    expect(metrics.auditRejectRate).toBeCloseTo((2 / 3) * 100);
    expect(metrics.retestPassRate).toBe(50);
    expect(metrics.managementMinutes).toBe(1.5);
    expect(metrics.managementMinutesSource).toBe("measured");
    // A real check-in with 0 study minutes is zero, not "no sample".
    expect(metrics.studyMinutes).toBe(0);
    expect(metrics.recallAvg).toBeCloseTo(0.8);
    expect(metrics.sample).toEqual({
      planned: 2,
      completed: 1,
      accepts: 1,
      rejects: 2,
      // 待判定不进分子也不进分母：驳回率仍是 2/3，而这条记录单独可见，
      // 否则"没人判过"在复盘页上等于没发生。
      pendingReview: 1,
    });
    expect(metrics.auditRejectRate).toBeCloseTo((2 / 3) * 100);
  });

  it("counts only the reviews that are still waiting on the user", async () => {
    const userId = "usr_metrics_pending";
    await createUser(userId);

    await db.insert(tasks).values([
      {
        id: "tsk_pending_open",
        userId,
        title: "open",
        description: "d",
        status: "needs_review",
        acceptanceCriteria: "c",
      },
      {
        id: "tsk_pending_decided",
        userId,
        title: "decided",
        description: "d",
        status: "accepted",
        acceptanceCriteria: "c",
      },
      {
        id: "tsk_pending_abandoned",
        userId,
        title: "abandoned",
        description: "d",
        status: "cancelled",
        acceptanceCriteria: "c",
      },
    ]);

    await db.insert(auditEvents).values([
      {
        id: "aud_pending_open",
        userId,
        actor: "agent",
        action: "audit.needs_review",
        target: "tsk_pending_open",
        hash: "hash-open",
      },
      {
        id: "aud_pending_decided",
        userId,
        actor: "agent",
        action: "audit.needs_review",
        target: "tsk_pending_decided",
        hash: "hash-decided",
      },
      {
        id: "aud_pending_decided_override",
        userId,
        actor: "user",
        action: "audit.override",
        target: "tsk_pending_decided",
        hash: "hash-override",
      },
      {
        id: "aud_pending_abandoned",
        userId,
        actor: "agent",
        action: "audit.needs_review",
        target: "tsk_pending_abandoned",
        hash: "hash-abandoned",
      },
    ]);

    const metrics = await getWeeklyMetrics(userId);

    // 判过的、放弃的都不再"停在你这里"：复盘页与首页待办读的必须是同一件事。
    expect(metrics.sample.pendingReview).toBe(1);
    // 人判不是审计样本：通过率仍然是"没有样本"，而不是 0%。
    expect(metrics.auditRejectRate).toBeNull();
  });

  it("does not count a cancelled plan against the week", async () => {
    const userId = "usr_metrics_cancelled";
    await createUser(userId);

    const now = new Date();
    await db.insert(tasks).values([
      {
        id: "tsk_cancelled_kept",
        userId,
        title: "done as planned",
        description: "d",
        status: "accepted",
        dueAt: now,
        acceptanceCriteria: "c",
      },
      {
        id: "tsk_cancelled_withdrawn",
        userId,
        title: "withdrawn",
        description: "d",
        status: "cancelled",
        dueAt: now,
        acceptanceCriteria: "c",
      },
    ]);

    const metrics = await getWeeklyMetrics(userId);

    // 撤回的计划不算「没做到」：目标进度（commands/progress.ts）与复测通过率
    // 都已经把 cancelled 排除在分母外，遵从率是同一个问题的第三个答案。
    expect(metrics.sample.planned).toBe(1);
    expect(metrics.adherence).toBe(100);
  });
  it("estimates management from decisions and keeps a sampled zero reject rate", async () => {
    const userId = "usr_metrics_estimated";
    await createUser(userId);

    await db.insert(auditEvents).values({
      id: "aud_metrics_user_accept",
      userId,
      actor: "user",
      action: "audit.accept",
      target: "tsk_metrics_estimated",
      hash: "hash-d",
    });

    const config = await getPolicyConfig();
    const metrics = await getWeeklyMetrics(userId);

    expect(metrics.managementMinutes).toBe(
      config.management.minutesPerDecision,
    );
    expect(metrics.managementMinutesSource).toBe("estimated");
    // One accept, zero rejects is a real 0% — not a missing sample.
    expect(metrics.auditRejectRate).toBe(0);
  });
});
