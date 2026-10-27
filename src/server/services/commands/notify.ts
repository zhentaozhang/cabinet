import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { outbox, users } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import type { Tx } from "../shared/tx";

/**
 * A notification is an outbox row, never a side effect of the request that
 * caused it: SMTP can be slow or down, and the causing mutation must not care.
 *
 * Enqueue is idempotent. The dedupe key defaults to "one row per event per UTC
 * day", so a retried mutation or a re-audited task cannot mail the user twice.
 */
/**
 * "review" 是 needs_review 的通知：没有结论本身就是一件要用户动手的事，
 * 而且它不会自己变好——只有用户判定之后任务才会离开这个状态。
 */
export type NotifyKind = "rejection" | "approval" | "budget" | "conflict" | "review";

export type NotifyInput = {
  userId: string;
  kind: NotifyKind;
  targetType: string;
  targetId: string;
  subject: string;
  body: string;
  href?: string | null;
  dedupeKey?: string;
  now?: Date;
};

export function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export async function enqueueNotification(
  input: NotifyInput,
  client: Tx | typeof db = db,
): Promise<{ enqueued: boolean; id: string }> {
  const now = input.now ?? new Date();
  const dedupeKey =
    input.dedupeKey ?? `${input.kind}:${input.targetId}:${dayKey(now)}`;
  const id = newId("obx");

  const inserted = await client
    .insert(outbox)
    .values({
      id,
      userId: input.userId,
      kind: input.kind,
      dedupeKey,
      subject: input.subject,
      body: input.body,
      targetType: input.targetType,
      targetId: input.targetId,
      href: input.href ?? null,
      nextAttemptAt: now,
    })
    .onConflictDoNothing({ target: [outbox.userId, outbox.dedupeKey] })
    .returning({ id: outbox.id });

  return { enqueued: inserted.length > 0, id: inserted[0]?.id ?? id };
}

/**
 * Only exceptions are mailed. A good day sends nothing — that is the product
 * claim, so every builder below names a failure the user must act on.
 */
export const notices = {
  rejection(input: {
    taskId: string;
    taskTitle: string;
    reason: string;
  }): { subject: string; body: string; href: string } {
    return {
      subject: `验收未通过：${input.taskTitle}`,
      href: `/tasks/${input.taskId}`,
      body: [
        `任务：${input.taskTitle}`,
        `判定：未通过`,
        `理由：${input.reason}`,
        "",
        "执行者不能给自己盖章。打开任务页可以看到每一条验收项的判定，以及缺了什么。",
      ].join("\n"),
    };
  },

  reviewNeeded(input: {
    taskId: string;
    taskTitle: string;
    reason: string;
    pending: number;
  }): { subject: string; body: string; href: string } {
    return {
      subject: `待你判定：${input.taskTitle}`,
      href: `/tasks/${input.taskId}`,
      body: [
        `任务：${input.taskTitle}`,
        `判定：没有结论（${input.pending} 条待判）`,
        `理由：${input.reason}`,
        "",
        "这一条不是驳回：执行本身可能没问题，只是有验收项没人能自动判定。",
        "在你判定之前，它不会算通过，也不会扣执行者的信任分。",
      ].join("\n"),
    };
  },

  budget(input: {
    agentName: string;
    taskTitle: string;
    reason: string;
  }): { subject: string; body: string; href: string } {
    return {
      subject: `${input.agentName} 的执行被预算拦下`,
      href: "/cabinet",
      body: [
        `${input.agentName} 有一次执行被预算策略拦下。`,
        `任务：${input.taskTitle}`,
        `原因：${input.reason}`,
        "",
        "预算用尽时任务不会降级执行，只会停下等你决定。",
      ].join("\n"),
    };
  },

  approval(input: {
    taskId: string;
    taskTitle: string;
    actionType: string;
    agentName?: string;
  }): { subject: string; body: string; href: string } {
    return {
      subject: `待你批准：${input.taskTitle}`,
      href: `/tasks/${input.taskId}`,
      body: [
        `${input.agentName ?? "执行 Agent"} 想执行一个外部动作（${input.actionType}）。`,
        `任务：${input.taskTitle}`,
        "",
        "批准只对这一次有效，不会顺带放宽同类动作。",
      ].join("\n"),
    };
  },

  conflict(input: {
    factKey: string;
    value: string | null;
    previous: string | null;
  }): { subject: string; body: string; href: string } {
    return {
      subject: `记忆冲突：${input.factKey}`,
      href: "/memory?view=current",
      body: [
        `记忆 ${input.factKey} 出现了两个互相矛盾的值。`,
        `新值：${input.value ?? "（空）"}`,
        input.previous ? `旧值：${input.previous}` : "旧值：（无）",
        "",
        "冲突不会被自动覆盖，需要你确认哪一条为准。",
      ].join("\n"),
    };
  },
};

/** Together with deleteAccount, this is the only writer of notification prefs. */
export async function updateNotifyPrefs(
  userId: string,
  input: { notifyEnabled: boolean; quietFrom: number; quietTo: number },
): Promise<void> {
  const hour = (value: number) => Math.min(23, Math.max(0, Math.trunc(value)));
  await db
    .update(users)
    .set({
      notifyEnabled: input.notifyEnabled,
      quietFrom: hour(input.quietFrom),
      quietTo: hour(input.quietTo),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

/** The row a caller should show in the delivery log, if any. */
export async function pendingNotificationsFor(userId: string) {
  return db
    .select()
    .from(outbox)
    .where(and(eq(outbox.userId, userId), eq(outbox.status, "pending")));
}
