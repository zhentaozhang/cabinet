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
    expect(metrics.sample).toEqual({
      planned: 0,
      completed: 0,
      accepts: 0,
      rejects: 0,
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
    });
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
