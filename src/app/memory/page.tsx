import type { Metadata } from "next";
import Link from "next/link";
import {
  Brain,
  Database,
  Fingerprint,
  Link2,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { fetchMemoryPage } from "@/lib/api/pages";
import { dateTime, pct } from "@/lib/format";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Progress,
  Stat,
} from "@/components/ui";
import { MemoryActions } from "@/components/memory-actions";

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

function typeTone(type: string) {
  if (type === "semantic") return "blue" as const;
  if (type === "episodic") return "teal" as const;
  return "violet" as const;
}

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const { type } = await searchParams;
  const data = await fetchMemoryPage(type);
  const avgConfidence =
    data.memories.length > 0
      ? data.memories.reduce((sum, m) => sum + m.confidence, 0) / data.memories.length
      : 0;
  const conflicts = data.memories.filter((m) => m.status === "conflicted").length;
  const stale = data.stale;

  return (
    <div>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-faint">
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
          <Stat label="Memories" value={data.counts.all} hint="条活跃记忆" />
        </Card>
        <Card className="px-4 py-3">
          <Stat label="Avg confidence" value={pct(avgConfidence * 100)} hint="平均置信度" />
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
              href={tab.key ? `/memory?type=${tab.key}` : "/memory"}
              className={
                active
                  ? "rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] text-accent"
                  : "rounded-md border border-line bg-panel2 px-2.5 py-1 text-[11px] text-muted hover:border-line2"
              }
            >
              {tab.label}
              <span className="ml-1.5 text-[9px] text-faint">
                {tab.key ? data.counts[tab.key as "semantic" | "episodic" | "procedural"] : data.counts.all}
              </span>
            </Link>
          );
        })}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.7fr_1fr]">
        <div className="space-y-3">
          {data.memories.length === 0 ? (
            <EmptyState title="没有匹配的记忆" hint="换个类型，或完成一次 check-in。" />
          ) : (
            data.memories.map((memory) => (
              <Card key={memory.id} className="px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={typeTone(memory.type)}>{memory.type}</Badge>
                    <Badge tone="neutral">{memory.domain}</Badge>
                    {memory.status !== "active" ? (
                      <Badge tone="danger">{memory.status}</Badge>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="mono text-[10px] text-muted">
                      {Math.round(memory.confidence * 100)}%
                    </span>
                    <MemoryActions memoryId={memory.id} />
                  </div>
                </div>

                <p className="mt-2.5 text-xs leading-relaxed text-[#c6ccd8]">{memory.content}</p>

                <div className="mt-3">
                  <Progress value={memory.confidence * 100} tone={memory.confidence >= 0.8 ? "teal" : "accent"} />
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 text-[9px] text-faint">
                    <Link2 className="size-2.5" /> evidence
                  </span>
                  {memory.evidence.map((e) => {
                    const ref = e.ref ?? "";
                    const content = (
                      <span
                        className="rounded border border-line bg-panel px-1.5 py-0.5 text-[9px] text-muted hover:border-line2"
                        title={e.quote}
                      >
                        {e.label}
                      </span>
                    );
                    return ref.startsWith("tsk_") ? (
                      <Link key={`${e.label}-${ref}`} href={`/tasks/${ref}`}>
                        {content}
                      </Link>
                    ) : (
                      <span key={`${e.label}-${ref}`}>{content}</span>
                    );
                  })}
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-3 text-[9px] text-faint">
                  <span>最后确认 {dateTime(memory.lastConfirmedAt)}</span>
                  {memory.sourceEventId ? (
                    <span className="mono">source: {memory.sourceEventId}</span>
                  ) : null}
                </div>
              </Card>
            ))
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader eyebrow="Governance" title="记忆治理" />
            <div className="space-y-3 px-5 py-4 text-[11px] leading-relaxed text-muted">
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
            <div className="space-y-3 px-5 py-4 text-[11px]">
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
