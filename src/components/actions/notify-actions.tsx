"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";

import { API_ROUTES, type NotifyPrefsDto } from "@/contracts";
import type { DeliveryRunDto } from "@/contracts/dto/aggregates";
import { Button } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { browserApi } from "@/lib/api/browser";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/**
 * Opt-out first: the checkbox disables everything, and quiet hours only shape
 * when the remaining messages land. Saving is explicit — a toggle that writes
 * on change would fire a mutation per arrow key.
 */
export function NotifyPrefsForm({ initial }: { initial: NotifyPrefsDto }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.notifyEnabled);
  const [quietFrom, setQuietFrom] = useState(initial.quietFrom);
  const [quietTo, setQuietTo] = useState(initial.quietTo);
  const [busy, setBusy] = useState(false);

  const dirty =
    enabled !== initial.notifyEnabled ||
    quietFrom !== initial.quietFrom ||
    quietTo !== initial.quietTo;

  async function save() {
    setBusy(true);
    const body = { notifyEnabled: enabled, quietFrom, quietTo };
    const result = await browserApi.mutate(API_ROUTES.notifications, {
      method: "PATCH",
      body,
    });
    setBusy(false);

    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(enabled ? "通知设置已保存" : "已关闭通知，之后不再发邮件");
    router.refresh();
  }

  return (
    <div className="space-y-4 px-5 py-4">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          className="mt-0.5 size-4 rounded border-line2 bg-sunken accent-[var(--color-accent)]"
        />
        <span>
          <span className="block text-body text-ink">用邮件通知我异常</span>
          <span className="mt-1 block text-label leading-relaxed text-faint">
            只会发需要你动手的事：验收未通过、等你批准、预算拦截、记忆冲突。正常的一天不会收到邮件。
          </span>
        </span>
      </label>

      <fieldset
        className="border-t border-line/70 pt-4"
        disabled={!enabled}
        aria-describedby="quiet-hint"
      >
        <legend className="mb-2 text-label text-muted">静默时段</legend>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="quiet-from" className="sr-only">
            静默开始时间
          </label>
          <select
            id="quiet-from"
            value={quietFrom}
            onChange={(event) => setQuietFrom(Number(event.target.value))}
            className="h-8 rounded-md border border-line2 bg-sunken px-2 text-label text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            {HOURS.map((hour) => (
              <option key={hour} value={hour}>
                {hourLabel(hour)}
              </option>
            ))}
          </select>
          <span className="text-label text-faint">到</span>
          <label htmlFor="quiet-to" className="sr-only">
            静默结束时间
          </label>
          <select
            id="quiet-to"
            value={quietTo}
            onChange={(event) => setQuietTo(Number(event.target.value))}
            className="h-8 rounded-md border border-line2 bg-sunken px-2 text-label text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            {HOURS.map((hour) => (
              <option key={hour} value={hour}>
                {hourLabel(hour)}
              </option>
            ))}
          </select>
        </div>
        <p id="quiet-hint" className="mt-2 text-label leading-relaxed text-faint">
          这个时段的邮件不会丢，只会推迟到静默结束后再发一次。
        </p>
      </fieldset>

      <div className="flex items-center gap-3 border-t border-line/70 pt-4">
        <Button onClick={save} disabled={!dirty || busy} variant="primary">
          {busy ? "保存中…" : dirty ? "保存设置" : "已保存"}
        </Button>
        {dirty ? <span className="text-label text-faint">有未保存的改动</span> : null}
      </div>
    </div>
  );
}

/** Manual pass: the same code path the cron job uses, scoped to this account. */
export function DeliverNowButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    const result = await browserApi.mutate<DeliveryRunDto>(
      API_ROUTES.notificationsRun,
      { method: "POST" },
    );
    setBusy(false);

    if (!result.ok) {
      toast.error(result.error);
      return;
    }

    const { sent, failed, skipped, deferred, waiting, lost, claimed } =
      result.data;
    if (lost > 0)
      toast.info(`有 ${lost} 封在处理中被另一个进程接手，本次结果未写回`);
    if (failed > 0) toast.error(`投递失败 ${failed} 封，原因见下方记录`);
    else if (sent > 0) toast.success(`已投递 ${sent} 封`);
    else if (waiting > 0)
      toast.info(`SMTP 还没配置，${waiting} 封仍在队列里，配置后会自动发出`);
    else if (claimed === 0)
      toast.info("没有到期的邮件，队列是空的");
    else toast.info(`没有可投递的邮件（跳过 ${skipped} · 推迟 ${deferred}）`);
    router.refresh();
  }

  return (
    <Button onClick={run} disabled={busy} variant="outline">
      <Send className="size-3.5" aria-hidden /> {busy ? "投递中…" : "现在投递一次"}
    </Button>
  );
}
