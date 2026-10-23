import { and, asc, eq, lte, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { outbox, users, type OutboxRow } from "@/lib/db/schema";
import {
  MAX_ATTEMPTS,
  isQuietHour,
  localHour,
  nextDeliveryAt,
  retryDelayMs,
} from "@/lib/domain/notify";
import {
  sendEmail,
  smtpConfigFromEnv,
  type EmailMessage,
  type EmailResult,
} from "@/lib/connectors/email";

export type DeliveryStep =
  | { id: string; kind: string; result: "sent" }
  | { id: string; kind: string; result: "failed"; reason: string }
  | { id: string; kind: string; result: "skipped"; reason: string }
  | { id: string; kind: string; result: "deferred"; reason: string; nextAttemptAt: Date }
  /** Nothing was attempted because SMTP is not configured; the mail is still owed. */
  | { id: string; kind: string; result: "waiting"; reason: string; nextAttemptAt: Date }
  | { id: string; kind: string; result: "would_send" };

export type DeliveryReport = {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  deferred: number;
  /** Due but not attempted: no SMTP host yet. Stays in the queue. */
  waiting: number;
  steps: DeliveryStep[];
};

/**
 * How long a claim is valid. A row stuck in `sending` — the process died
 * between claiming and writing back — becomes claimable again after this.
 */
const CLAIM_LEASE_MS = 5 * 60 * 1000;

/** Retry interval while SMTP is missing. Retrying sooner cannot help. */
const NOT_CONFIGURED_DELAY_MS = 60 * 60 * 1000;

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

  /**
   * Due = pending and past its time, or a stale claim whose runner died. The
   * claim below sets `nextAttemptAt` to now + lease, so the same column doubles
   * as a lease deadline and no extra column is needed.
   */
  const due = and(
    or(eq(outbox.status, "pending"), eq(outbox.status, "sending")),
    lte(outbox.nextAttemptAt, now),
  );
  const scope = options.userId
    ? and(eq(outbox.userId, options.userId), due)
    : due;

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
    waiting: 0,
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
        // A dry run that claims "would send" without an SMTP host would be a
        // lie, and this is the mode an operator uses to diagnose exactly that.
        if (smtpConfigFromEnv() === null) {
          report.waiting += 1;
          report.steps.push({
            id: row.id,
            kind: row.kind,
            result: "waiting",
            reason: "SMTP 未配置，真跑也不会发出",
            nextAttemptAt: now,
          });
          continue;
        }
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
      .set({
        status: "sending",
        nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      })
      .where(
        and(
          eq(outbox.id, row.id),
          or(eq(outbox.status, "pending"), eq(outbox.status, "sending")),
          lte(outbox.nextAttemptAt, now),
        ),
      )
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

    /**
     * "not configured" is not a delivery failure AND not terminal: nothing was
     * attempted, and an operator may configure SMTP tomorrow. The row goes
     * back to `pending` an hour out — attempts are not consumed, because no
     * attempt happened — so the owed mail is delivered once a host exists.
     */
    if (result.status === "not_configured") {
      const next = new Date(now.getTime() + NOT_CONFIGURED_DELAY_MS);
      await db
        .update(outbox)
        .set({
          status: "pending",
          nextAttemptAt: next,
          lastError: "SMTP 未配置（SMTP_HOST / SMTP_FROM），邮件未发送",
        })
        .where(eq(outbox.id, row.id));
      report.waiting += 1;
      report.steps.push({
        id: row.id,
        kind: row.kind,
        result: "waiting",
        reason: "SMTP 未配置，邮件仍留在队列里",
        nextAttemptAt: next,
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
