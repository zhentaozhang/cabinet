import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { approvals, outbox, users } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { notifyKindLabel } from "@/contracts";
import { auditTask, createTask, runTask } from "@/server/services/engine";
import {
  deliverOutbox,
  decideDelivery,
} from "@/server/services/commands/delivery";
import {
  enqueueNotification,
  notices,
  updateNotifyPrefs,
} from "@/server/services/commands/notify";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

const okSender = async () => ({ status: "sent" as const });

describe("outbox enqueue", () => {
  it("is idempotent for the same event on the same day", async () => {
    const input = {
      userId: DEMO_USER_ID,
      kind: "rejection" as const,
      targetType: "task",
      targetId: "tsk_test",
      subject: "s",
      body: "b",
    };

    expect((await enqueueNotification(input)).enqueued).toBe(true);
    expect((await enqueueNotification(input)).enqueued).toBe(false);

    const rows = await db
      .select()
      .from(outbox)
      .where(eq(outbox.userId, DEMO_USER_ID));
    expect(rows).toHaveLength(1);
  });

  it("dedupes on the user's own day, not the UTC one", async () => {
    // 07:50 与 09:10（Asia/Shanghai，演示账号的时区）落在两个 UTC 日期、
    // 同一个本地日：按 UTC 日算，同一件事会在一个上午里发两封邮件。
    const base = {
      userId: DEMO_USER_ID,
      kind: "rejection" as const,
      targetType: "task",
      targetId: "tsk_local_day",
      subject: "s",
      body: "b",
    };

    const first = await enqueueNotification({
      ...base,
      now: new Date("2026-02-28T23:50:00Z"),
    });
    const second = await enqueueNotification({
      ...base,
      now: new Date("2026-03-01T01:10:00Z"),
    });
    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);

    // 反过来：同一个 UTC 日、跨了本地午夜，是两天的事，各发一次。
    const beforeMidnight = await enqueueNotification({
      ...base,
      targetId: "tsk_next_local_day",
      now: new Date("2026-03-01T15:30:00Z"),
    });
    const afterMidnight = await enqueueNotification({
      ...base,
      targetId: "tsk_next_local_day",
      now: new Date("2026-03-01T16:10:00Z"),
    });
    expect(beforeMidnight.enqueued).toBe(true);
    expect(afterMidnight.enqueued).toBe(true);
  });
  it("records a rejected audit, and nothing else", async () => {
    // The checklist asks for far more words than the artifact has, so the
    // Auditor has a definite failure to report — and a rejection is the
    // notifiable event. (A rule that cannot be judged would end in
    // "needs_review" instead, which nobody is notified about.)
    const task = await createTask(
      {
        title: "整理检索证据",
        description: "需要真实外部证据。",
        assigneeId: "ag_research",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        acceptanceCriteria: "至少 5000 字的正文。",
        acceptanceChecklist: [{ type: "min_words", value: 5000, required: true }],
        estimateMin: 10,
        createdBy: "agent",
      },
      DEMO_USER_ID,
    );

    await runTask(task.id, DEMO_USER_ID);
    const result = await auditTask(task.id, DEMO_USER_ID);
    expect(result.decision).toBe("rejected");

    const rows = await db
      .select()
      .from(outbox)
      .where(eq(outbox.userId, DEMO_USER_ID));
    const rejections = rows.filter((row) => row.kind === "rejection");

    expect(rejections).toHaveLength(1);
    expect(rejections[0].subject).toContain("验收未通过");
    expect(rejections[0].href).toBe(`/tasks/${task.id}`);
    expect(rejections[0].body).toContain(result.reason.slice(0, 10));

    // Running the audit again must not queue a second mail.
    const again = await auditTask(task.id, DEMO_USER_ID).catch(() => null);
    if (again) {
      const after = await db.select().from(outbox);
      expect(after.filter((row) => row.kind === "rejection")).toHaveLength(1);
    }
  });

  it("enqueues an approval request without duplicating it", async () => {
    // The seed ships tsk_booking with a pending approval already; clearing it
    // forces the "new approval" path, which is the one that must send mail.
    await db.delete(approvals).where(eq(approvals.taskId, "tsk_booking"));

    const first = await runTask("tsk_booking", DEMO_USER_ID);
    expect(first).toMatchObject({ requiresApproval: true });

    // A second run must not queue a second mail for the same pending approval.
    await runTask("tsk_booking", DEMO_USER_ID);

    const rows = await db
      .select()
      .from(outbox)
      .where(and(eq(outbox.userId, DEMO_USER_ID), eq(outbox.kind, "approval")));
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toContain("待你批准");
  });

  it("has human labels for every kind", () => {
    expect(notifyKindLabel("rejection")).toBe("验收未通过");
    expect(notifyKindLabel("unknown-kind")).toBe("unknown-kind");
  });
});

describe("delivery", () => {
  /*
   * These cases are about the delivery mechanics — claiming, retry, lease,
   * dedupe — not about what o'clock it is. The demo account is quiet from
   * 22:00 to 08:00 Asia/Shanghai, so running the suite in the evening deferred
   * every row and turned the whole block into a coin flip on the wall clock.
   * Close the window here (from === to means "no window" in isQuietHour); the
   * cases that are about quiet hours open it again themselves.
   */
  beforeEach(async () => {
    await updateNotifyPrefs(DEMO_USER_ID, {
      notifyEnabled: true,
      quietFrom: 0,
      quietTo: 0,
    });
  });

  it("sends a due row and marks it sent", async () => {
    await enqueueNotification({
      userId: DEMO_USER_ID,
      kind: "budget",
      targetType: "task",
      targetId: "tsk_x",
      ...notices.budget({
        agentName: "Atlas",
        taskTitle: "预算任务",
        reason: "本周预算已用尽",
      }),
    });

    const report = await deliverOutbox({ sender: okSender });

    expect(report.sent).toBe(1);
    const [row] = await db.select().from(outbox);
    expect(row.status).toBe("sent");
    expect(row.sentAt).not.toBeNull();
  });

  it("skips when the user turned notifications off", async () => {
    await updateNotifyPrefs(DEMO_USER_ID, {
      notifyEnabled: false,
      quietFrom: 22,
      quietTo: 8,
    });
    await enqueueNotification({
      userId: DEMO_USER_ID,
      kind: "budget",
      targetType: "task",
      targetId: "tsk_y",
      subject: "s",
      body: "b",
    });

    const report = await deliverOutbox({ sender: okSender });

    expect(report.sent).toBe(0);
    expect(report.skipped).toBe(1);
    const [row] = await db.select().from(outbox);
    expect(row.status).toBe("skipped");
    expect(row.lastError).toContain("关闭");
  });

  it("defers during quiet hours instead of dropping the message", async () => {
    // A window covering the whole day: everything is quiet, always.
    await updateNotifyPrefs(DEMO_USER_ID, {
      notifyEnabled: true,
      quietFrom: 22,
      quietTo: 8,
    });
    await enqueueNotification({
      userId: DEMO_USER_ID,
      kind: "budget",
      targetType: "task",
      targetId: "tsk_z",
      subject: "s",
      body: "b",
    });

    // Pin the instant instead of hoping it is quiet: 15:00Z is 23:00 in
    // Asia/Shanghai, inside the 22:00–08:00 window of the demo account.
    // A window like 0–23 would look "all day" but leave hour 23 outside it.
    const before = new Date();
    const at = new Date("2030-01-01T15:00:00Z");
    const report = await deliverOutbox({ sender: okSender, now: at });

    expect(report.deferred).toBe(1);
    const [row] = await db.select().from(outbox);
    expect(row.status).toBe("pending");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("keeps a missing SMTP configuration in the queue instead of dropping it", async () => {
    await enqueueNotification({
      userId: DEMO_USER_ID,
      kind: "budget",
      targetType: "task",
      targetId: "tsk_n",
      subject: "s",
      body: "b",
    });

    const report = await deliverOutbox({
      sender: async () => ({ status: "not_configured" as const }),
    });

    expect(report.waiting).toBe(1);
    expect(report.skipped).toBe(0);
    const [row] = await db.select().from(outbox);
    // Still owed: configuring SMTP later must deliver it.
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.lastError).toContain("SMTP");
  });

  it("reclaims a row whose runner died while sending", async () => {
    await enqueueNotification({
      userId: DEMO_USER_ID,
      kind: "budget",
      targetType: "task",
      targetId: "tsk_stale",
      subject: "s",
      body: "b",
    });
    // Simulate a crash: claimed, lease already expired, nothing written back.
    await db.update(outbox).set({
      status: "sending",
      nextAttemptAt: new Date(Date.now() - 60_000),
    });

    const report = await deliverOutbox({ sender: okSender });

    expect(report.claimed).toBe(1);
    expect(report.sent).toBe(1);
    const [row] = await db.select().from(outbox);
    expect(row.status).toBe("sent");
  });

  it("refuses to write back a result it no longer owns", async () => {
    await enqueueNotification({
      userId: DEMO_USER_ID,
      kind: "budget",
      targetType: "task",
      targetId: "tsk_lost",
      subject: "s",
      body: "b",
    });

    // A second runner takes the lease while this one is mid-send, which is what
    // happens when the first process stalls past its lease and is reclaimed.
    const hijack = async () => {
      await db
        .update(outbox)
        .set({ claimToken: "clm_other", nextAttemptAt: new Date(Date.now() + 60_000) })
        .where(eq(outbox.id, (await db.select().from(outbox))[0].id));
      return { status: "sent" as const };
    };

    const report = await deliverOutbox({ sender: hijack });

    expect(report.lost).toBe(1);
    expect(report.sent).toBe(0);
    const [row] = await db.select().from(outbox);
    // The stale runner must not overwrite the new owner's row.
    expect(row.status).toBe("sending");
    expect(row.claimToken).toBe("clm_other");
  });

  it("clears the claim token once it writes the outcome", async () => {
    await enqueueNotification({
      userId: DEMO_USER_ID,
      kind: "budget",
      targetType: "task",
      targetId: "tsk_claim_clear",
      subject: "s",
      body: "b",
    });

    await deliverOutbox({ sender: okSender });

    const [row] = await db.select().from(outbox);
    expect(row.status).toBe("sent");
    expect(row.claimToken).toBeNull();
  });

  it("does not steal a claim that is still inside its lease", async () => {
    await enqueueNotification({
      userId: DEMO_USER_ID,
      kind: "budget",
      targetType: "task",
      targetId: "tsk_lease",
      subject: "s",
      body: "b",
    });
    await db.update(outbox).set({
      status: "sending",
      nextAttemptAt: new Date(Date.now() + 120_000),
    });

    const report = await deliverOutbox({ sender: okSender });

    expect(report.claimed).toBe(0);
    const [row] = await db.select().from(outbox);
    expect(row.status).toBe("sending");
  });

  it("retries a real failure with backoff, then gives up", async () => {
    await enqueueNotification({
      userId: DEMO_USER_ID,
      kind: "budget",
      targetType: "task",
      targetId: "tsk_f",
      subject: "s",
      body: "b",
    });

    const failing = async () => ({ status: "failed" as const, error: "连接被拒绝" });

    await deliverOutbox({ sender: failing });
    let [row] = await db.select().from(outbox);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("连接被拒绝");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await db
        .update(outbox)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(outbox.id, row.id));
      await deliverOutbox({ sender: failing });
      [row] = await db.select().from(outbox);
    }

    expect(row.status).toBe("failed");
    expect(row.attempts).toBeGreaterThanOrEqual(4);
  });

  it("does not send the same row twice when two runners race", async () => {
    await enqueueNotification({
      userId: DEMO_USER_ID,
      kind: "budget",
      targetType: "task",
      targetId: "tsk_race",
      subject: "s",
      body: "b",
    });

    let calls = 0;
    const slowSender = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: "sent" as const };
    };

    await Promise.all([
      deliverOutbox({ sender: slowSender }),
      deliverOutbox({ sender: slowSender }),
    ]);

    expect(calls).toBe(1);
  });

  it("a manual pass only touches the current user", async () => {
    await db.insert(users).values({
      id: "usr_notify_other",
      email: "notify-other@cabinet.local",
      name: "Other",
      emailVerified: true,
      timezone: "Asia/Shanghai",
      updatedAt: new Date(),
    });
    await enqueueNotification({
      userId: "usr_notify_other",
      kind: "budget",
      targetType: "task",
      targetId: "tsk_other",
      subject: "other",
      body: "b",
    });

    const report = await deliverOutbox({ userId: DEMO_USER_ID, sender: okSender });

    expect(report.claimed).toBe(0);
    const rows = await db.select().from(outbox);
    expect(rows[0].status).toBe("pending");
  });

  it("decides from preferences, not from the row", () => {
    const recipient = {
      email: "u@example.test",
      timezone: "Asia/Shanghai",
      notifyEnabled: true,
      quietFrom: 22,
      quietTo: 8,
    };
    const at = new Date("2026-10-22T02:00:00Z"); // 10:00 Shanghai
    expect(decideDelivery({ status: "pending", createdAt: at }, recipient, at)).toEqual({
      action: "send",
    });
    expect(
      decideDelivery({ status: "pending", createdAt: at }, { ...recipient, notifyEnabled: false }, at),
    ).toEqual({ action: "skip", reason: "用户关闭了通知" });
    expect(decideDelivery({ status: "pending", createdAt: at }, null, at).action).toBe(
      "skip",
    );
  });
});
