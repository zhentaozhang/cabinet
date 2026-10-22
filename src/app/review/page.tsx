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
  WeeklyReviewButton,
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

const DISSENT_STATUS: Record<
  string,
  { label: string; tone: "accent" | "teal" | "neutral" }
> = {
  pending: { label: "观察中", tone: "accent" },
  vindicated: { label: "已平反", tone: "teal" },
  invalidated: { label: "已证伪", tone: "neutral" },
};

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

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{
    insightOffset?: string;
    dissentOffset?: string;
  }>;
}) {
  const params = await searchParams;
  const insightOffset = Math.max(Number(params.insightOffset ?? 0) || 0, 0);
  const dissentOffset = Math.max(Number(params.dissentOffset ?? 0) || 0, 0);
  const data = await fetchReviewPage({ insightOffset, dissentOffset });
  const tz = data.user.timezone;
  const metrics = data.weeklyMetrics;
  const agentById = new Map(data.agents.map((agent) => [agent.id, agent]));
  const applied = data.insights.filter((i) => i.status === "applied");
  const pageHref = (next: {
    insightOffset?: number;
    dissentOffset?: number;
  }) => {
    const query = new URLSearchParams();
    const nextInsight = next.insightOffset ?? insightOffset;
    const nextDissent = next.dissentOffset ?? dissentOffset;
    if (nextInsight > 0) query.set("insightOffset", String(nextInsight));
    if (nextDissent > 0) query.set("dissentOffset", String(nextDissent));
    const qs = query.toString();
    return qs ? `/review?${qs}` : "/review";
  };
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
          <div className="mb-2 flex items-center gap-2 text-eyebrow font-medium uppercase tracking-[0.2em] text-faint">
            <ClipboardCheck className="size-3 text-accent" />
            Review · {data.weekly?.period ?? "—"}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">周复盘</h1>
          <p className="mt-1.5 text-xs text-muted">
            这一页回答三件事：发生了什么、学到了什么、下周改什么。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {metrics.managementMinutes !== null &&
          metrics.managementMinutesSource === "estimated" ? (
            <Badge tone="neutral">管理时间估算</Badge>
          ) : null}
          <WeeklyReviewButton />
          <Badge tone="teal">
            <ShieldCheck className="size-2.5" /> 每条结论可点回证据
          </Badge>
        </div>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Study", `${metrics.studyMinutes}m`, "本周学习时长"],
          [
            "Recall",
            metrics.recallAvg === null
              ? "—"
              : `${Math.round(metrics.recallAvg * 100)}%`,
            "回忆正确率",
          ],
          ["Learning", String(metrics.learningTasks), "已验收学习任务"],
          ["Goal", `${metrics.goalProgress.toFixed(0)}%`, "主目标进度"],
          ["AAO / week", String(metrics.aao), "被接受的自主结果"],
          [
            "Audit reject",
            metrics.auditRejectRate === null
              ? "—"
              : `${metrics.auditRejectRate.toFixed(0)}%`,
            metrics.auditRejectRate === null ? "暂无审计数据" : "驳回率",
          ],
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
              right={<span className="text-label text-faint">{dateTime(data.weekly?.createdAt, tz)}</span>}
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
                  <Badge tone="accent">{data.insightProposedTotal} 待采纳</Badge>
                  <ReflectButton />
                </div>
              }
            />
            <div className="space-y-3">
              {data.insights.map((insight) => (
                <InsightCard key={insight.id} insight={insight} />
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-label text-faint">
              <span>
                第 {data.insights.length === 0 ? 0 : data.insightOffset + 1}–
                {data.insightOffset + data.insights.length} 条 / 共{" "}
                {data.insightTotal}
              </span>
              <div className="flex items-center gap-1.5">
                {data.insightOffset > 0 ? (
                  <Link
                    href={pageHref({
                      insightOffset: Math.max(0, data.insightOffset - data.limit),
                    })}
                    className="rounded-md border border-line bg-panel2 px-2 py-1 text-muted hover:border-line2"
                  >
                    上一页
                  </Link>
                ) : null}
                {data.insightOffset + data.insights.length < data.insightTotal ? (
                  <Link
                    href={pageHref({
                      insightOffset: data.insightOffset + data.limit,
                    })}
                    className="rounded-md border border-line bg-panel2 px-2 py-1 text-muted hover:border-line2"
                  >
                    下一页
                  </Link>
                ) : null}
              </div>
            </div>
          </div>

          <Card>
            <CardHeader
              eyebrow="Dissent"
              title="异议与判例"
              right={
                <span className="text-label text-faint">
                  {data.dissentPendingTotal} 观察中
                </span>
              }
            />
            {data.dissents.length === 0 ? (
              <div className="px-5 py-4 text-label text-muted">
                还没有正式异议。批准一场存在反对立场的会议后，异议会进入观察期。
              </div>
            ) : (
              <div className="divide-y divide-line">
                {data.dissents.map((dissent) => {
                  const status =
                    DISSENT_STATUS[dissent.status] ?? DISSENT_STATUS.pending;
                  const agent = agentById.get(dissent.agentId);
                  return (
                    <div key={dissent.id} className="px-5 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={status.tone}>{status.label}</Badge>
                        <span className="text-label font-medium text-ink">
                          {agent?.name ?? dissent.agentId}
                        </span>
                        <span className="text-label text-faint">
                          {dissent.condition.metric} {dissent.condition.operator}{" "}
                          {dissent.condition.threshold} ·{" "}
                          {dissent.condition.windowDays} 天
                        </span>
                      </div>
                      <p className="mt-1.5 text-label leading-relaxed text-muted">
                        {dissent.warning}
                      </p>
                      <div className="mt-1 text-label text-faint">
                        提出 {dateTime(dissent.createdAt, tz)}
                        {dissent.evaluatedAt
                          ? ` · 评估 ${dateTime(dissent.evaluatedAt, tz)}`
                          : ""}
                        {dissent.evidence.length > 0
                          ? ` · ${dissent.evidence.length} 条证据`
                          : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3 text-label text-faint">
              <span>
                第 {data.dissents.length === 0 ? 0 : data.dissentOffset + 1}–
                {data.dissentOffset + data.dissents.length} 条 / 共{" "}
                {data.dissentTotal}
              </span>
              <div className="flex items-center gap-1.5">
                {data.dissentOffset > 0 ? (
                  <Link
                    href={pageHref({
                      dissentOffset: Math.max(0, data.dissentOffset - data.limit),
                    })}
                    className="rounded-md border border-line bg-panel2 px-2 py-1 text-muted hover:border-line2"
                  >
                    上一页
                  </Link>
                ) : null}
                {data.dissentOffset + data.dissents.length < data.dissentTotal ? (
                  <Link
                    href={pageHref({
                      dissentOffset: data.dissentOffset + data.limit,
                    })}
                    className="rounded-md border border-line bg-panel2 px-2 py-1 text-muted hover:border-line2"
                  >
                    下一页
                  </Link>
                ) : null}
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Diff" title="本周改了什么" right={<GitCompareArrows className="size-3.5 text-faint" />} />
            <div className="divide-y divide-line">
              {(data.weekly?.decisions ?? []).map((decision, i) => (
                <div key={i} className="flex items-center gap-2 px-5 py-3 text-label">
                  <span className="mono text-accent">{String(decision.action ?? "change")}</span>
                  <span className="text-faint">→</span>
                  <span className="text-muted">{String(decision.target ?? "")}</span>
                  <span className="ml-auto text-faint">{String(decision.result ?? "")}</span>
                </div>
              ))}
              {applied.map((insight) => (
                <div key={insight.id} className="flex items-center gap-2 px-5 py-3 text-label">
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
              {data.agents.length === 0 ? (
                <div className="px-5 py-6 text-center text-label text-faint">
                  还没有在岗的 Agent。创建工作区后，这里会按信任分给出升级或退休建议。
                </div>
              ) : null}
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
                      <div className="truncate text-label text-ink">{agent.name}</div>
                      <div className="text-label text-faint">
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
              {data.audit.length === 0 ? (
                <div className="px-5 py-6 text-center text-label text-faint">
                  还没有审计记录。第一次验收通过后，这里会写下第一条哈希链事件。
                </div>
              ) : null}
              {data.audit.slice(0, 8).map((event) => (
                <div key={event.id} className="px-5 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="mono text-label text-muted">{event.action}</span>
                    <span className="ml-auto text-label text-faint">{dateTime(event.createdAt, tz)}</span>
                  </div>
                  <div className="mt-0.5 truncate text-label text-faint">
                    {event.actor} → {event.target}
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-line px-5 py-2.5 text-label text-faint">
              哈希链：每条记录包含前一条的 hash，改动可被发现。
            </div>
          </Card>

          <Card className="border-teal/20 bg-teal/[0.03]">
            <div className="flex items-start gap-3 px-5 py-4">
              <TrendingUp className="mt-0.5 size-4 text-teal" />
              <div>
                <div className="text-xs font-medium text-ink">下一周的唯一目标</div>
                {focus ? (
                  <p className="mt-1 text-label leading-relaxed text-muted">
                    <Link href={`/tasks/${focus.id}`} className="text-ink hover:underline">
                      {focus.title}
                    </Link>
                    {` · 优先级 ${focus.priority}`}
                    {focus.dueAt ? ` · 截止 ${shortDate(focus.dueAt, tz)}` : ""}
                  </p>
                ) : (
                  <p className="mt-1 text-label leading-relaxed text-muted">
                    本周没有未收尾的任务。
                  </p>
                )}
                <Link
                  href="/cabinet"
                  className="mt-2 inline-flex items-center gap-1 text-label text-teal hover:underline"
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
