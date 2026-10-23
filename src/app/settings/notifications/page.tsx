import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock, Mail, Send } from "lucide-react";

import { Badge, Card, CardHeader, EmptyState, SectionTitle } from "@/components/ui";
import { DeliverNowButton, NotifyPrefsForm } from "@/components/actions";
import {
  deliveryStatusLabel,
  deliveryStatusTone,
  notifyKindLabel,
} from "@/contracts";
import { fetchDeliveryPage } from "@/lib/api/pages";
import { dateTime } from "@/lib/format";

export const metadata: Metadata = {
  title: "通知 · Cabinet",
  description: "异常邮件：什么时候发、发到哪、为什么没发出去。",
};

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const data = await fetchDeliveryPage();
  const owed = data.counts.pending;
  const inFlight = data.counts.sending;
  const failed = data.counts.failed;

  return (
    <div className="space-y-5">
      <div>
        <SectionTitle
          title="通知"
          hint="只有需要你动手的事才会发邮件。记录在这里，发没发出去都能查。"
        />
      </div>

      <Card>
        <CardHeader
          eyebrow="Delivery"
          title="邮件通道"
          right={
            data.email.configured ? (
              <div className="flex items-center gap-1 text-teal">
                <CheckCircle2 className="size-3.5" aria-hidden />
                <span className="text-label">已配置</span>
              </div>
            ) : (
              <Badge tone="neutral">未配置</Badge>
            )
          }
        />
        <div className="space-y-3 px-5 py-4">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-label text-muted">发件服务器</span>
            <span className="text-body text-ink">
              {data.email.configured ? `${data.email.host} · ${data.email.from}` : "无"}
            </span>
          </div>
          {data.email.configured ? null : (
            <p className="text-label leading-relaxed text-faint">
              需要在部署环境里设置{" "}
              <code className="rounded bg-sunken px-1">{data.email.envVars.join(" / ")}</code>
              。没配置时邮件会留在队列里、每小时重试一次，配置好之后自动发出，不会假装发送成功。
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 border-t border-line/70 pt-3">
            <DeliverNowButton />
            <span className="text-label text-faint">
              调度由部署层的 cron 执行 <code className="rounded bg-sunken px-1">notify:deliver</code>
              ，不在网页进程里定时。
            </span>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Preferences"
          title="通知偏好"
          right={
            data.prefs.notifyEnabled ? (
              <Badge tone="teal">开启</Badge>
            ) : (
              <Badge tone="neutral">已关闭</Badge>
            )
          }
        />
        <NotifyPrefsForm initial={data.prefs} />
      </Card>

      <Card>
        <CardHeader
          eyebrow="Outbox"
          title="投递记录"
          right={
            <div className="flex items-center gap-3 text-label text-faint">
              {owed > 0 ? <span>待投递 {owed}</span> : null}
              {inFlight > 0 ? <span>发送中 {inFlight}</span> : null}
              {failed > 0 ? <span className="text-danger">失败 {failed}</span> : null}
              <span>已送达 {data.counts.sent}</span>
            </div>
          }
        />
        {data.items.length === 0 ? (
          <div className="px-5 py-6">
            <EmptyState
              title="还没有需要通知你的事"
              hint="任务通过验收、预算正常、没有冲突的日子，这里会一直是空的。"
            />
          </div>
        ) : (
          <ul className="divide-y divide-line/70">
            {data.items.map((item) => (
              <li key={item.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={deliveryStatusTone(item.status)}>
                    {deliveryStatusLabel(item.status)}
                  </Badge>
                  <span className="text-label text-muted">{notifyKindLabel(item.kind)}</span>
                  <span className="text-body text-ink">{item.subject}</span>
                  <span className="ml-auto mono text-label text-faint">
                    {dateTime(item.createdAt, data.timezone)}
                  </span>
                </div>
                {item.href ? (
                  <Link
                    href={item.href}
                    className="mt-1.5 inline-block text-label text-accent underline decoration-accent/40 underline-offset-2"
                  >
                    打开对应页面
                  </Link>
                ) : null}
                {item.lastError ? (
                  <p className="mt-1.5 flex items-start gap-1.5 text-label leading-relaxed text-danger">
                    <AlertTriangle className="mt-0.5 size-3" aria-hidden />
                    {item.lastError}
                    {item.attempts > 0 ? `（已尝试 ${item.attempts} 次）` : ""}
                  </p>
                ) : null}
                {item.status === "pending" ? (
                  <p className="mt-1.5 flex items-center gap-1.5 text-label text-faint">
                    <Clock className="size-3" aria-hidden />
                    下次尝试 {dateTime(item.nextAttemptAt, data.timezone)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader eyebrow="How it works" title="为什么这样做" />
        <ul className="space-y-2 px-5 py-4 text-label leading-relaxed text-ink-soft">
          <li className="flex items-start gap-2">
            <Mail className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
            通知先进队列，再由独立进程投递：请求不会卡在 SMTP 握手上，失败也能重试。
          </li>
          <li className="flex items-start gap-2">
            <Send className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
            同一件事一天最多发一次；投递失败会按 1 分钟、5 分钟、15 分钟退避重试，四次后标记失败。
          </li>
          <li className="flex items-start gap-2">
            <Clock className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
            静默时段的邮件只是推迟，不会丢弃；关掉通知则不再入队发送。
          </li>
        </ul>
      </Card>
    </div>
  );
}
