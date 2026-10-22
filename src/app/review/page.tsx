import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  ClipboardCheck,
  GitCompareArrows,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { fetchReviewPage } from "@/lib/api/pages";
import { passRate, roleMeta } from "@/lib/agents";
import { dateTime, money, shortDate } from "@/lib/format";
import {
  Avatar,
  Badge,
  Card,
  CardHeader,
  SectionTitle,
  Stat,
} from "@/components/ui";
import {
  InsightCard,
  ReflectButton,
  VerifyAuditButton,
} from "@/components/actions";
import type { PolicyConfigDto } from "@/contracts";
import { Markdown } from "@/components/markdown";

export const metadata: Metadata = {
  title: "Review · Cabinet",
};

export const dynamic = "force-dynamic";

type AuditStat = { accepts: number; total: number; passRate: number };

function recommendation(
  agent: {
    role: string;
    lifecycleStage: string;
    trustScore: number;
    successCount: number;
    failCount: number;
  },
  stats: AuditStat,
  config: PolicyConfigDto,
) {
  if (agent.role === "apprentice" && agent.lifecycleStage !== "active") {
    return { label: "待转正", tone: "accent" as const };
  }
  if (stats.total === 0) {
    return { label: "暂无审计", tone: "neutral" as const };
  }
  if (agent.failCount > agent.successCount) {
    return { label: "考虑退休", tone: "danger" as const };
  }
  if (
    agent.trustScore >= config.autonomy.minTrust &&
    agent.successCount >= config.autonomy.minSuccesses &&
    stats.passRate >= config.autonomy.minAuditPassRate
  ) {
    return { label: "可升级", tone: "teal" as const };
  }
  if (agent.trustScore < 60) {
    return { label: "观察", tone: "accent" as const };
  }
  return { label: "保持", tone: "neutral" as const };
}

const OPEN_TASK_STATUS = new Set([
  "planned",
  "assigned",
  "awaiting_approval",
  "approved",
  "suggested",
  "running",
  "submitted",
  "auditing",
  "rejected",
]);

export default async function ReviewPage() {
  const data = await fetchReviewPage();
  const metrics = data.weeklyMetrics;
  const applied = data.insights.filter((i) => i.status === "applied");
  const proposed = data.insights.filter((i) => i.status === "proposed");
  const focus = data.tasks
    .filter((task) => OPEN_TASK_STATUS.has(task.status))
    .sort(
      (a, b) =>
        b.priority - a.priority || (a.dueAt ?? "").localeCompare(b.dueAt ?? ""),
    )[0];

  return (
    <div>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-faint">
            <ClipboardCheck className="size-3 text-accent" />
            Review · {data.weekly?.period ?? "—"}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">周复盘</h1>
          <p className="mt-1.5 text-xs text-muted">
            这一页回答三件事：发生了什么、学到了什么、下周改什么。
          </p>
        </div>
        <Badge tone="teal">
          <ShieldCheck className="size-2.5" /> 每条结论可点回证据
        </Badge>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["AAO / week", String(metrics.aao), "被接受的自主结果"],
          ["Adherence", `${metrics.adherence.toFixed(0)}%`, "计划依从性"],
          ["Management", `${metrics.managementMinutes.toFixed(1)}m`, "每日管理时间"],
          ["Cost", `$${metrics.costUsd.toFixed(2)}`, "本周模型成本"],
          ["Goal", `${metrics.goalProgress.toFixed(0)}%`, "主目标进度"],
          ["Audit reject", `${metrics.auditRejectRate.toFixed(0)}%`, "驳回率"],
        ].map(([label, value, hint]) => (
          <Card key={label} className="px-4 py-3">
            <Stat label={label} value={value} hint={hint} />
          </Card>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.7fr_1fr]">
        <div className="space-y-5">
          <Card>
            <CardHeader
              eyebrow="Narrative"
              title="本周叙事"
              right={<span className="text-[10px] text-faint">{dateTime(data.weekly?.createdAt)}</span>}
            />
            <div className="px-5 py-4">
              <Markdown content={data.weekly?.narrative ?? "本周还没有复盘。"} />
            </div>
          </Card>

          <div>
            <SectionTitle
              eyebrow="Learning"
              title="洞察与变更"
              hint="采纳会改变下周计划；回滚会恢复原状，并留下审计记录。"
              right={
                <div className="flex items-center gap-2">
                  <Badge tone="accent">{proposed.length} 待采纳</Badge>
                  <ReflectButton />
                </div>
              }
            />
            <div className="space-y-3">
              {data.insights.map((insight) => (
                <InsightCard key={insight.id} insight={insight} />
              ))}
            </div>
          </div>

          <Card>
            <CardHeader eyebrow="Diff" title="本周改了什么" right={<GitCompareArrows className="size-3.5 text-faint" />} />
            <div className="divide-y divide-line">
              {(data.weekly?.decisions ?? []).map((decision, i) => (
                <div key={i} className="flex items-center gap-2 px-5 py-3 text-[11px]">
                  <span className="mono text-accent">{String(decision.action ?? "change")}</span>
                  <span className="text-faint">→</span>
                  <span className="text-muted">{String(decision.target ?? "")}</span>
                  <span className="ml-auto text-faint">{String(decision.result ?? "")}</span>
                </div>
              ))}
              {applied.map((insight) => (
                <div key={insight.id} className="flex items-center gap-2 px-5 py-3 text-[11px]">
                  <span className="mono text-teal">applied</span>
                  <span className="text-faint">→</span>
                  <span className="truncate text-muted">{insight.claim}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader eyebrow="Agent performance" title="内阁绩效" />
            <div className="divide-y divide-line">
              {data.agents.map((agent) => {
                const rate = passRate(agent.successCount, agent.failCount);
                const rec = recommendation(
                  agent,
                  data.auditStats[agent.id] ?? {
                    accepts: 0,
                    total: 0,
                    passRate: 0,
                  },
                  data.config,
                );
                const meta = roleMeta(agent.role);
                return (
                  <Link
                    key={agent.id}
                    href={`/cabinet/${agent.id}`}
                    className="flex items-center gap-2.5 px-5 py-3 transition-colors hover:bg-white/[0.02]"
                  >
                    <Avatar initials={agent.avatar} accent={meta.accent} size={28} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px] text-ink">{agent.name}</div>
                      <div className="text-[9px] text-faint">
                        {rate}% pass · L{agent.autonomyLevel} · {money(agent.spentCents)}
                      </div>
                    </div>
                    <Badge tone={rec.tone}>{rec.label}</Badge>
                  </Link>
                );
              })}
            </div>
          </Card>

          <Card>
            <CardHeader
              eyebrow="Audit trail"
              title="审计日志"
              right={<VerifyAuditButton />}
            />
            <div className="divide-y divide-line">
              {data.audit.slice(0, 8).map((event) => (
                <div key={event.id} className="px-5 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="mono text-[10px] text-muted">{event.action}</span>
                    <span className="ml-auto text-[9px] text-faint">{dateTime(event.createdAt)}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[9px] text-faint">
                    {event.actor} → {event.target}
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-line px-5 py-2.5 text-[9px] text-faint">
              哈希链：每条记录包含前一条的 hash，改动可被发现。
            </div>
          </Card>

          <Card className="border-teal/20 bg-teal/[0.03]">
            <div className="flex items-start gap-3 px-5 py-4">
              <TrendingUp className="mt-0.5 size-4 text-teal" />
              <div>
                <div className="text-xs font-medium text-ink">下一周的唯一目标</div>
                {focus ? (
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">
                    <Link href={`/tasks/${focus.id}`} className="text-ink hover:underline">
                      {focus.title}
                    </Link>
                    {` · 优先级 ${focus.priority}`}
                    {focus.dueAt ? ` · 截止 ${shortDate(focus.dueAt)}` : ""}
                  </p>
                ) : (
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">
                    本周没有未收尾的任务。
                  </p>
                )}
                <Link
                  href="/cabinet"
                  className="mt-2 inline-flex items-center gap-1 text-[10px] text-teal hover:underline"
                >
                  查看 Agent 绩效 <ArrowRight className="size-3" />
                </Link>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
