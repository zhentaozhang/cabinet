import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, Link2, SearchX, ShieldCheck } from "lucide-react";
import { fetchAuditPage } from "@/lib/api/pages";
import { dateTime } from "@/lib/format";
import { Badge, Card, CardHeader, EmptyState } from "@/components/ui";
import { AuditChainCheck } from "./audit-chain-check";
import { cn } from "@/lib/format";
import { statusLabel } from "@/contracts/labels";

export const metadata: Metadata = {
  title: "审计日志 · Cabinet",
};

export const dynamic = "force-dynamic";

const PAGE_SIZE = 40;

/** Colour the two verdicts that carry meaning; everything else stays neutral. */
function actionTone(action: string) {
  if (action === "audit.accept") return "teal" as const;
  if (action === "audit.reject") return "danger" as const;
  if (action.startsWith("council.")) return "violet" as const;
  if (action.startsWith("autonomy.")) return "accent" as const;
  return "neutral" as const;
}

function hrefFor(kind: string | null, offset: number) {
  const params = new URLSearchParams();
  if (kind) params.set("kind", kind);
  if (offset > 0) params.set("offset", String(offset));
  const query = params.toString();
  return query ? `/review/audit?${query}` : "/review/audit";
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; offset?: string }>;
}) {
  const params = await searchParams;
  const kind = params.kind?.trim() ? params.kind.trim() : null;
  const parsedOffset = Number(params.offset ?? 0);
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;

  const page = await fetchAuditPage({ kind, offset });
  if ("missing" in page) notFound();

  const { data } = page;
  const tz = data.timezone;

  return (
    <div>
      <Link
        href="/review"
        className="mb-5 inline-flex items-center gap-1 text-label text-faint hover:text-muted"
      >
        <ArrowLeft className="size-3" /> 返回本周复盘
      </Link>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-eyebrow tracking-[0.16em] text-faint uppercase">
            Audit trail
          </div>
          <h1 className="mt-1 text-page font-semibold tracking-tight text-ink">
            审计日志
          </h1>
          <p className="mt-1.5 max-w-2xl text-label leading-relaxed text-muted">
            每一次验收、审批和授权变更都在这里留下一条哈希链记录。改动任何一条，
            后面所有记录的 hash 校验都会失败。
          </p>
        </div>
        {/* 校验结论要留在页面上被对照，所以不是页头一行小字，而是一块结果面板。 */}
        <AuditChainCheck total={data.total} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <Link
          href={hrefFor(null, 0)}
          className={cn(
            "rounded-md border px-2.5 py-1 text-label transition-colors",
            kind === null
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-line bg-panel2 text-muted hover:border-line2",
          )}
        >
          全部
          <span className="ml-1.5 text-faint">{data.total}</span>
        </Link>
        {data.kinds.map((entry) => {
          const active = kind === entry.kind;
          return (
            <Link
              key={entry.kind}
              href={hrefFor(entry.kind, 0)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-label transition-colors",
                active
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-line bg-panel2 text-muted hover:border-line2",
              )}
            >
              {statusLabel(entry.kind)}
              <span className="ml-1.5 text-faint">{entry.count}</span>
            </Link>
          );
        })}
      </div>

      <Card>
        <CardHeader
          eyebrow={kind ? `Filtered · ${kind}` : "All events"}
          title="事件流"
          right={
            <span className="text-label text-faint">
              {data.filteredTotal} 条
            </span>
          }
        />
        {data.events.length === 0 ? (
          <div className="px-5 py-8">
            <EmptyState
              icon={<SearchX className="size-4" />}
              title="没有匹配的审计事件"
              hint="换一个筛选条件，或者先完成一次验收。"
            />
          </div>
        ) : (
          <div className="divide-line divide-y">
            {data.events.map((event) => (
              <div key={event.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={actionTone(event.action)}>{event.action}</Badge>
                  <span className="mono text-label text-faint">
                    #{event.seq}
                  </span>
                  <span className="text-label text-faint">
                    {event.actor} → {event.target}
                  </span>
                  <span className="ml-auto text-label text-faint">
                    {dateTime(event.createdAt, tz)}
                  </span>
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-3 text-label text-faint">
                  <span className="inline-flex items-center gap-1">
                    <Link2 className="size-2.5" />
                    <span className="mono">{event.hash.slice(0, 12)}</span>
                  </span>
                  {event.prevHash ? (
                    <span className="mono">
                      前一条 {event.prevHash.slice(0, 12)}
                    </span>
                  ) : (
                    <span>链首</span>
                  )}
                </div>

                {event.before || event.after ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-label text-faint hover:text-muted">
                      查看变更
                    </summary>
                    {/* `min-w-0` lets the `pre` scroll instead of widening the grid track. */}
                    <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                      <div className="min-w-0">
                        <div className="mb-1 text-label text-faint">before</div>
                        <pre className="overflow-x-auto rounded border border-line bg-sunken p-2 text-label leading-relaxed text-muted">
                          {JSON.stringify(event.before, null, 2)}
                        </pre>
                      </div>
                      <div className="min-w-0">
                        <div className="mb-1 text-label text-faint">after</div>
                        <pre className="overflow-x-auto rounded border border-line bg-sunken p-2 text-label leading-relaxed text-teal/80">
                          {JSON.stringify(event.after, null, 2)}
                        </pre>
                      </div>
                    </div>
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3 text-label text-faint">
          <span>
            第 {data.events.length === 0 ? 0 : data.offset + 1}–
            {data.offset + data.events.length} 条 / 共 {data.filteredTotal}
          </span>
          <div className="flex items-center gap-1.5">
            {data.offset > 0 ? (
              <Link
                href={hrefFor(kind, Math.max(0, data.offset - PAGE_SIZE))}
                className="inline-flex items-center gap-1 rounded-md border border-line bg-panel2 px-2 py-1 text-muted hover:border-line2"
              >
                <ArrowLeft className="size-3" /> 更新
              </Link>
            ) : null}
            {data.hasMore ? (
              <Link
                href={hrefFor(kind, data.offset + PAGE_SIZE)}
                className="inline-flex items-center gap-1 rounded-md border border-line bg-panel2 px-2 py-1 text-muted hover:border-line2"
              >
                更早 <ArrowRight className="size-3" />
              </Link>
            ) : null}
          </div>
        </div>
      </Card>

      <div className="mt-3 flex items-start gap-2 text-label leading-relaxed text-faint">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-teal" />
        <p>
          上面「校验审计链」会重新计算每条记录的 hash，并比对 prevHash。出现不一致时，
          结果里会指出第一条对不上的事件 id；校验失败（网络或服务端报错）时会原样
          显示报错原文，不给出任何「链是完整的」结论。
        </p>
      </div>
    </div>
  );
}
