import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { insights, tasks, users } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { applyInsight } from "@/server/services/commands/memory/insights";
import { setupWorkspace } from "@/lib/setup";
import { localDateTimeParts, zonedTimeToUtc } from "@/lib/domain/time";
import { NotFoundError } from "@/lib/domain/errors";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("insight task isolation and timezone", () => {
  it("rejects an insight that points at another tenant's task", async () => {
    await db.insert(users).values({
      id: "usr_insight_other",
      email: "insight-other@cabinet.local",
      name: "Other",
      emailVerified: true,
      timezone: "Asia/Shanghai",
      updatedAt: new Date(),
    });
    await db.insert(tasks).values({
      id: "tsk_insight_other",
      userId: "usr_insight_other",
      title: "Other task",
      description: "Must not be rescheduled by another tenant.",
      status: "planned",
      acceptanceCriteria: "有产物",
      estimateMin: 25,
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 0,
      createdBy: "user",
      dueAt: new Date("2030-01-01T21:00:00.000Z"),
    });
    await db.insert(insights).values({
      id: "ins_cross_tenant",
      userId: DEMO_USER_ID,
      claim: "reschedule another tenant's task",
      rationale: "security test",
      confidence: 0.5,
      evidence: [],
      proposedChange: {
        type: "reschedule",
        taskId: "tsk_insight_other",
        from: "21:00",
        to: "09:00",
      },
      status: "proposed",
    });

    await expect(
      applyInsight("ins_cross_tenant", "accept", DEMO_USER_ID),
    ).rejects.toBeInstanceOf(NotFoundError);

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_insight_other"));
    expect(task.dueAt?.toISOString()).toBe("2030-01-01T21:00:00.000Z");
  });

  it("applies the reschedule in the user's timezone", async () => {
    const userId = "usr_insight_utc";
    await db.insert(users).values({
      id: userId,
      email: "insight-utc@cabinet.local",
      name: "UTC User",
      emailVerified: true,
      timezone: "UTC",
      updatedAt: new Date(),
    });
    await setupWorkspace({ userId, timezone: "UTC" });
    await db.insert(tasks).values({
      id: "tsk_insight_utc",
      userId,
      title: "UTC task",
      description: "Timezone test",
      status: "planned",
      acceptanceCriteria: "有产物",
      estimateMin: 25,
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 0,
      createdBy: "user",
      dueAt: new Date("2030-01-01T21:00:00.000Z"),
    });
    await db.insert(insights).values({
      id: "ins_timezone",
      userId,
      claim: "reschedule in user timezone",
      rationale: "timezone test",
      confidence: 0.5,
      evidence: [],
      proposedChange: {
        type: "reschedule",
        taskId: "tsk_insight_utc",
        from: "21:00",
        to: "09:00",
      },
      status: "proposed",
    });

    // 09:00 还没到：应当仍然排到今天 09:00，不能无谓顺延一天。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T06:30:00.000Z"));
    await applyInsight("ins_timezone", "accept", userId);

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_insight_utc"));
    const today = localDateTimeParts(new Date(), "UTC");
    const expected = zonedTimeToUtc(
      today.year,
      today.month,
      today.day,
      9,
      0,
      "UTC",
    );
    expect(task.dueAt?.toISOString()).toBe(expected.toISOString());
  });

  it("moves the task to the next occurrence when that hour already passed today", async () => {
    const userId = "usr_insight_past_slot";
    await db.insert(users).values({
      id: userId,
      email: "insight-past@cabinet.local",
      name: "Past Slot User",
      emailVerified: true,
      timezone: "UTC",
      updatedAt: new Date(),
    });
    await setupWorkspace({ userId, timezone: "UTC" });
    await db.insert(tasks).values({
      id: "tsk_insight_past_slot",
      userId,
      title: "Evening task",
      description: "A task the reflection insight asks to move to the morning.",
      status: "planned",
      acceptanceCriteria: "有产物",
      estimateMin: 25,
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 0,
      createdBy: "user",
      dueAt: new Date("2030-01-01T21:00:00.000Z"),
    });
    await db.insert(insights).values({
      id: "ins_past_slot",
      userId,
      claim: "move the evening task to the morning",
      rationale: "energy pattern test",
      confidence: 0.5,
      evidence: [],
      proposedChange: {
        type: "reschedule",
        taskId: "tsk_insight_past_slot",
        from: "21:00",
        to: "09:00",
      },
      status: "proposed",
    });

    // 21:30 采纳：今天的 09:00 已经过去，写成今天 09:00 就是一条当场逾期的任务。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T21:30:00.000Z"));
    await applyInsight("ins_past_slot", "accept", userId);

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_insight_past_slot"));
    expect(task.dueAt?.toISOString()).toBe("2026-10-29T09:00:00.000Z");
  });
});
