import type { Metadata } from "next";
import Link from "next/link";
import {
  Brain,
  Database,
  Fingerprint,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { fetchMemoryPage } from "@/lib/api/pages";
import { pct } from "@/lib/format";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Stat,
} from "@/components/ui";
import { MemoryRow } from "@/components/memory-row";

export const metadata: Metadata = {
  title: "Memory · Cabinet",
};

export const dynamic = "force-dynamic";

const TABS = [
  { key: "", label: "全部" },
  { key: "semantic", label: "语义" },
  { key: "episodic", label: "情景" },
  { key: "procedural", label: "程序" },
];

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; view?: string; offset?: string }>;
}) {
  const params = await searchParams;
  const type = params.type;
  const view = params.view === "history" ? "history" : "current";
  const offset = Math.max(Number(params.offset ?? 0) || 0, 0);
  const data = await fetchMemoryPage(type, view, { offset });
  const tz = data.timezone;
  const avgConfidence =
    data.memories.length > 0
      ? data.memories.reduce((sum, m) => sum + m.confidence, 0) / data.memories.length
      : null;
  const conflicts = data.memories.filter((m) => m.status === "conflicted").length;
  const stale = data.stale;
  const pageHref = (nextOffset: number) => {
    const query = new URLSearchParams();
    if (type) query.set("type", type);
    if (view === "history") query.set("view", "history");
    if (nextOffset > 0) query.set("offset", String(nextOffset));
    const qs = query.toString();
    return qs ? `/memory?${qs}` : "/memory";
  };
  const hrefFor = (nextType: string) => {
    const query = new URLSearchParams();
    if (nextType) query.set("type", nextType);
    if (view === "history") query.set("view", "history");
    const qs = query.toString();
    return qs ? `/memory?${qs}` : "/memory";
  };

  return (
    <div>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-eyebrow font-medium uppercase tracking-[0.2em] text-faint">
            <Brain className="size-3 text-accent" />
            Memory
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">记忆中心</h1>
          <p className="mt-1.5 text-xs text-muted">
            它记住了你什么、证据在哪、你能不能改。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="teal">
            <ShieldCheck className="size-2.5" /> 无来源不写入
          </Badge>
          <Badge tone="accent">
            <Fingerprint className="size-2.5" /> 可编辑 / 可删除
          </Badge>
        </div>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="px-4 py-3">
          <Stat
            label="Memories"
            value={data.counts.all}
            hint={view === "history" ? "条历史事实" : "条当前事实"}
          />
        </Card>
        <Card className="px-4 py-3">
          <Stat
            label="Avg confidence"
            value={avgConfidence === null ? "—" : pct(avgConfidence * 100)}
            hint={avgConfidence === null ? "暂无记忆" : "平均置信度"}
          />
        </Card>
        <Card className="px-4 py-3">
          <Stat label="Conflicts" value={conflicts} hint="待解决矛盾" />
        </Card>
        <Card className="px-4 py-3">
          <Stat label="Stale" value={stale} hint="已过期" />
        </Card>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-1.5">
        {TABS.map((tab) => {
          const active = (type ?? "") === tab.key;
          return (
            <Link
              key={tab.key || "all"}
              href={hrefFor(tab.key)}
              className={
                active
                  ? "rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-label text-accent"
                  : "rounded-md border border-line bg-panel2 px-2.5 py-1 text-label text-muted hover:border-line2"
              }
            >
              {tab.label}
              <span className="ml-1.5 text-label text-faint">
                {tab.key ? data.counts[tab.key as "semantic" | "episodic" | "procedural"] : data.counts.all}
              </span>
            </Link>
          );
        })}
      </div>

      <div className="mb-5 flex items-center gap-1.5">
        <Link
          href={hrefFor(type ?? "")}
          className={
            view === "current"
              ? "rounded-md border border-teal/40 bg-teal/10 px-2.5 py-1 text-label text-teal"
              : "rounded-md border border-line bg-panel2 px-2.5 py-1 text-label text-muted hover:border-line2"
          }
        >
          当前事实
        </Link>
        <Link
          href={`/memory?${new URLSearchParams({
            ...(type ? { type } : {}),
            view: "history",
          }).toString()}`}
          className={
            view === "history"
              ? "rounded-md border border-violet/40 bg-violet/10 px-2.5 py-1 text-label text-violet"
              : "rounded-md border border-line bg-panel2 px-2.5 py-1 text-label text-muted hover:border-line2"
          }
        >
          历史版本
        </Link>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.7fr_1fr]">
        <div className="space-y-3">
          {data.memories.length === 0 ? (
            <EmptyState
              title={view === "history" ? "没有历史版本" : "没有匹配的记忆"}
              hint={
                view === "history"
                  ? "事实被新版本取代后会保留在这里。"
                  : "换个类型，或完成一次 check-in。"
              }
            />
          ) : (
            data.memories.map((memory) => (
              <MemoryRow
                key={memory.id}
                memory={memory}
                view={view}
                tz={tz}
              />
            ))
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-label text-faint">
          <span>
            第 {data.memories.length === 0 ? 0 : data.offset + 1}–
            {data.offset + data.memories.length} 条 / 共 {data.total}
          </span>
          <div className="flex items-center gap-1.5">
            {data.offset > 0 ? (
              <Link
                href={pageHref(Math.max(0, data.offset - data.limit))}
                className="rounded-md border border-line bg-panel2 px-2 py-1 text-muted hover:border-line2"
              >
                上一页
              </Link>
            ) : null}
            {data.hasMore ? (
              <Link
                href={pageHref(data.offset + data.limit)}
                className="rounded-md border border-line bg-panel2 px-2 py-1 text-muted hover:border-line2"
              >
                下一页
              </Link>
            ) : null}
          </div>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader eyebrow="Governance" title="记忆治理" />
            <div className="space-y-3 px-5 py-4 text-label leading-relaxed text-muted">
              <div className="flex gap-2">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-teal" />
                <p>没有来源事件的记忆不许写入，防止模型编造。</p>
              </div>
              <div className="flex gap-2">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-accent" />
                <p>健康、财务、关系等高影响记忆必须由你确认。</p>
              </div>
              <div className="flex gap-2">
                <Database className="mt-0.5 size-3.5 shrink-0 text-blue" />
                <p>冲突时不静默覆盖：标记「待确认」，保留双方证据。</p>
              </div>
              <div className="flex gap-2">
                <Brain className="mt-0.5 size-3.5 shrink-0 text-violet" />
                <p>低置信、长期未确认的记忆自动降权，支持遗忘。</p>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Legend" title="三种记忆" />
            <div className="space-y-3 px-5 py-4 text-label">
              <div>
                <Badge tone="teal">episodic</Badge>
                <p className="mt-1 text-muted">发生了什么：check-in、事件、结果。</p>
              </div>
              <div>
                <Badge tone="blue">semantic</Badge>
                <p className="mt-1 text-muted">关于你的事实：偏好、约束、精力模式。</p>
              </div>
              <div>
                <Badge tone="violet">procedural</Badge>
                <p className="mt-1 text-muted">怎么做事：技能、步骤、护栏。</p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
