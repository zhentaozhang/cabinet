import Link from "next/link";
import { Link2 } from "lucide-react";
import type { MemoryDto } from "@/contracts";
import { dateTime } from "@/lib/format";
import { Badge, Card, Progress, StatusBadge } from "@/components/ui";
import { MemoryActions } from "@/components/memory-actions";
import { memoryTypeLabel } from "@/contracts/labels";
import { isSimulatedSource, sourceLabel } from "@/lib/domain/provenance";

function typeTone(type: string) {
  if (type === "semantic") return "blue" as const;
  if (type === "episodic") return "teal" as const;
  if (type === "procedural") return "violet" as const;
  return "neutral" as const;
}

/** A single date row inside the metadata column. */
function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-faint">{label}</dt>
      <dd className="mono truncate text-right text-muted" title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * One memory, split into "what it says" and "how much we trust it".
 *
 * Stacked vertically on small screens; from `lg` the evidence and the metadata
 * sit side by side, because scanning a list is mostly reading the left column.
 */
export function MemoryRow({
  memory,
  view,
  tz,
}: {
  memory: MemoryDto;
  view: "current" | "history";
  tz: string;
}) {
  const confidence = Math.round(memory.confidence * 100);
  const tone = memory.confidence >= 0.8 ? "teal" : "accent";

  return (
    <Card className={view === "history" ? "px-5 py-4 opacity-70" : "px-5 py-4"}>
      <div className="lg:grid lg:grid-cols-[1.55fr_1fr] lg:gap-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={typeTone(memory.type)}>{memoryTypeLabel(memory.type)}</Badge>
            <Badge tone="neutral">{memory.domain}</Badge>
            {memory.factKey ? <Badge tone="blue">{memory.factKey}</Badge> : null}
            {memory.status !== "active" ? (
              <StatusBadge status={memory.status} />
            ) : null}
            {/*
              Provenance, always shown. Demo and rule-written memories would
              otherwise read exactly like something the user or a model
              established, which is the one confusion this page must not allow.
            */}
            <Badge
              tone={isSimulatedSource(memory.sourceType) ? "violet" : "neutral"}
              title={`来源：${sourceLabel(memory.sourceType)}`}
            >
              {sourceLabel(memory.sourceType)}
            </Badge>
          </div>

          <p className="mt-2.5 text-label leading-relaxed text-ink-soft">
            {memory.content}
          </p>
          {memory.value ? (
            <p className="mt-1 text-label text-accent">事实值：{memory.value}</p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-label text-faint">
              <Link2 className="size-2.5" /> evidence
            </span>
            {memory.evidence.length === 0 ? (
              <span className="text-label text-faint">无来源</span>
            ) : (
              memory.evidence.map((e) => {
                const ref = e.ref ?? "";
                const content = (
                  <span
                    className="rounded border border-line bg-panel px-1.5 py-0.5 text-label text-muted hover:border-line2"
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
              })
            )}
          </div>
        </div>

        <div className="mt-3.5 lg:mt-0 lg:border-line lg:border-l lg:pl-6">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-eyebrow tracking-[0.14em] text-faint uppercase">
              confidence
            </span>
            <span className="mono text-emphasis text-ink">{confidence}%</span>
          </div>
          <Progress
            value={confidence}
            tone={tone}
            label="记忆置信度"
            className="mt-1.5"
          />

          <dl className="mt-3 space-y-1 text-label">
            <Meta label="生效" value={dateTime(memory.validFrom, tz)} />
            {memory.validTo ? (
              <Meta label="失效" value={dateTime(memory.validTo, tz)} />
            ) : null}
            <Meta
              label="最后确认"
              value={dateTime(memory.lastConfirmedAt, tz)}
            />
            {memory.supersededBy ? (
              <Meta label="已被取代" value={memory.supersededBy} />
            ) : null}
            {memory.sourceEventId ? (
              <Meta label="来源事件" value={memory.sourceEventId} />
            ) : null}
          </dl>

          {view === "current" ? (
            <div className="mt-3 flex justify-end">
              <MemoryActions memoryId={memory.id} />
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
