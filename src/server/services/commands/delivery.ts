import { and, asc, eq, lte } from "drizzle-orm";

import { db } from "@/lib/db";
import { outbox, users, type OutboxRow } from "@/lib/db/schema";
import {
  MAX_ATTEMPTS,
  isQuietHour,
  localHour,
  nextDeliveryAt,
  retryDelayMs,
} from "@/lib/domain/notify";
import { sendEmail, type EmailMessage, type EmailResult } from "@/lib/connectors/email";

export type DeliveryStep =
  | { id: string; kind: string; result: "sent" }
  | { id: string; kind: string; result: "failed"; reason: string }
  | { id: string; kind: string; result: "skipped"; reason: string }
  | { id: string; kind: string; result: "deferred"; reason: string; nextAttemptAt: Date }
  | { id: string; kind: string; result: "would_send" };

export type DeliveryReport = {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  deferred: number;
  steps: DeliveryStep[];
};

type Recipient = {
  email: string;
  timezone: string;
  notifyEnabled: boolean;
  quietFrom: number;
  quietTo: number;
};

type Decision =
  | { action: "send" }
  | { action: "skip"; reason: string }
  | { action: "defer"; reason: string; nextAttemptAt: Date };

/**
 * Decide what to do with one row, given the recipient's preferences.
 *
 * Order matters: an opted-out user is skipped before any quiet-hour arithmetic,
 * and quiet hours defer rather than skip — the message is still owed.
 */
export function decideDelivery(
  row: Pick<OutboxRow, "status" | "createdAt">,
  recipient: Recipient | null,
  at: Date,
): Decision {
  if (!recipient) return { action: "skip", reason: "收件人已不存在" };
  if (!recipient.notifyEnabled) return { action: "skip", reason: "用户关闭了通知" };

  const hour = localHour(at, recipient.timezone);
  if (hour !== null && isQuietHour(hour, recipient.quietFrom, recipient.quietTo)) {
    const next = nextDeliveryAt(at, recipient.timezone, recipient.quietFrom, recipient.quietTo);
    return {
      action: "defer",
      reason: `静默时段（${recipient.quietFrom}:00–${recipient.quietTo}:00）`,
      nextAttemptAt: next,
    };
  }

  return { action: "send" };
}

async function loadRecipient(userId: string): Promise<Recipient | null> {
  const [user] = await db
    .select({
      email: users.email,
      timezone: users.timezone,
      notifyEnabled: users.notifyEnabled,
      quietFrom: users.quietFrom,
      quietTo: users.quietTo,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user ?? null;
}

function toMessage(row: OutboxRow, recipient: Recipient): EmailMessage {
  const link = row.href ? `\n\n打开：${row.href}` : "";
  return {
    to: recipient.email,
    subject: row.subject,
    text: `${row.body}${link}\n\n—— Cabinet\n不需要的话可以在 设置 · 通知 里关掉。`,
  };
}

/**
 * Deliver due outbox rows.
 *
 * Rows are claimed one at a time with a conditional status transition, so a
 * second runner starting at the same second cannot send the same mail twice.
 */
export async function deliverOutbox(
  options: {
    now?: Date;
    limit?: number;
    dryRun?: boolean;
    /** Scope a manual pass to one account; the cron job passes no user. */
    userId?: string;
    sender?: (message: EmailMessage) => Promise<EmailResult>;
  } = {},
): Promise<DeliveryReport> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const send = options.sender ?? ((message: EmailMessage) => sendEmail(message));
  const dryRun = options.dryRun === true;

  const scope = options.userId
    ? and(
        eq(outbox.userId, options.userId),
        eq(outbox.status, "pending"),
        lte(outbox.nextAttemptAt, now),
      )
    : and(eq(outbox.status, "pending"), lte(outbox.nextAttemptAt, now));

  const candidates = await db
    .select()
    .from(outbox)
    .where(scope)
    .orderBy(asc(outbox.createdAt))
    .limit(limit);

  const report: DeliveryReport = {
    claimed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    steps: [],
  };

  const recipients = new Map<string, Recipient | null>();

  for (const row of candidates) {
    if (!recipients.has(row.userId)) {
      recipients.set(row.userId, await loadRecipient(row.userId));
    }
    const recipient = recipients.get(row.userId) ?? null;
    const decision = decideDelivery(row, recipient, now);

    if (dryRun) {
      if (decision.action === "send") {
        report.steps.push({ id: row.id, kind: row.kind, result: "would_send" });
      } else if (decision.action === "skip") {
        report.skipped += 1;
        report.steps.push({
          id: row.id,
          kind: row.kind,
          result: "skipped",
          reason: decision.reason,
        });
      } else {
        report.deferred += 1;
        report.steps.push({
          id: row.id,
          kind: row.kind,
          result: "deferred",
          reason: decision.reason,
          nextAttemptAt: decision.nextAttemptAt,
        });
      }
      continue;
    }

    // Claim: only the runner that wins this transition may touch the row.
    const [claimed] = await db
      .update(outbox)
      .set({ status: "sending" })
      .where(and(eq(outbox.id, row.id), eq(outbox.status, "pending")))
      .returning({ id: outbox.id });
    if (!claimed) continue;
    report.claimed += 1;

    if (decision.action === "skip") {
      await db
        .update(outbox)
        .set({ status: "skipped", lastError: decision.reason })
        .where(eq(outbox.id, row.id));
      report.skipped += 1;
      report.steps.push({
        id: row.id,
        kind: row.kind,
        result: "skipped",
        reason: decision.reason,
      });
      continue;
    }

    if (decision.action === "defer") {
      await db
        .update(outbox)
        .set({ status: "pending", nextAttemptAt: decision.nextAttemptAt })
        .where(eq(outbox.id, row.id));
      report.deferred += 1;
      report.steps.push({
        id: row.id,
        kind: row.kind,
        result: "deferred",
        reason: decision.reason,
        nextAttemptAt: decision.nextAttemptAt,
      });
      continue;
    }

    const result = await send(toMessage(row, recipient as Recipient));
    if (result.status === "sent") {
      await db
        .update(outbox)
        .set({ status: "sent", sentAt: new Date(), lastError: null })
        .where(eq(outbox.id, row.id));
      report.sent += 1;
      report.steps.push({ id: row.id, kind: row.kind, result: "sent" });
      continue;
    }

    // "not configured" is not a delivery failure: nothing was attempted, and
    // retrying cannot help until an operator sets SMTP_HOST. It is recorded as
    // skipped so the log never implies the mail left the building.
    if (result.status === "not_configured") {
      await db
        .update(outbox)
        .set({
          status: "skipped",
          lastError: "SMTP 未配置（SMTP_HOST / SMTP_FROM），邮件未发送",
        })
        .where(eq(outbox.id, row.id));
      report.skipped += 1;
      report.steps.push({
        id: row.id,
        kind: row.kind,
        result: "skipped",
        reason: "SMTP 未配置",
      });
      continue;
    }

    const reason = result.error;
    const attempts = row.attempts + 1;
    const exhausted = attempts >= MAX_ATTEMPTS;

    await db
      .update(outbox)
      .set({
        status: exhausted ? "failed" : "pending",
        attempts,
        lastError: reason,
        nextAttemptAt: exhausted ? row.nextAttemptAt : new Date(now.getTime() + retryDelayMs(attempts)),
      })
      .where(eq(outbox.id, row.id));

    report.failed += 1;
    report.steps.push({ id: row.id, kind: row.kind, result: "failed", reason });
  }

  return report;
}
