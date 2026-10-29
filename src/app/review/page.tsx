import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Bot,
  ChevronRight,
  ClipboardCheck,
  ExternalLink,
  FileClock,
  FileCode2,
  GitCompareArrows,
  ListTree,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import { fetchReviewPage } from "@/lib/api/pages";
import { passRate, roleMeta } from "@/lib/agents";
import {
  DISSENT_STATUS,
  listPageState,
  pickFocusTask,
  recommendation,
  weeklyNarrativeState,
} from "@/lib/presentation/review-view";
import { cn, dateTime, shortDate } from "@/lib/format";
import { recallAverageHint } from "@/lib/presentation/recall-view";
import { dissentConditionText } from "@/lib/domain/dissent-metric";
import {
  Avatar,
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Progress,
  SectionTitle,
  Stat,
} from "@/components/ui";
import {
  InsightCard,
  ReflectButton,
  VerifyAuditButton,
  WeeklyReviewButton,
} from "@/components/actions";
import { Markdown } from "@/components/markdown";
import { MasteryCard } from "./mastery-card";

export const metadata: Metadata = {
  title: "Review · Cabinet",
};

export const dynamic = "force-dynamic";


/** A section is a numbered band of the page, not another card. */
function Section({
  index,
  title,
  hint,
  children,
  className,
}: {
  index: string;
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-8 border-t border-line/60 pt-6", className)}>
      <div className="mb-4 flex items-baseline gap-3">
        <span className="mono text-eyebrow uppercase tracking-[0.2em] text-faint">
          {index}
        </span>
        <div className="min-w-0">
          <h2 className="text-section font-semibold tracking-tight text-ink">{title}</h2>
          {hint ? <p className="mt-1 text-body text-muted">{hint}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

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
  // 已生效的洞察来自整张表（`appliedInsights`），不是在当前这页里筛：
  // 洞察先被提出、后来才被采纳，生效的那几条往往正好落在更早的页上。
  const applied = data.appliedInsights;
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
  const focus = pickFocusTask(data.tasks);
  const insightPage = listPageState(data.insightTotal, data.insights.length);
  const dissentPage = listPageState(data.dissentTotal, data.dissents.length);

  const zeroSampleAgents = data.agents.filter(
    (agent) => (data.auditStats[agent.id]?.total ?? 0) === 0,
  ).length;
  const auditSamplesThisWeek = metrics.sample.accepts + metrics.sample.rejects;
  // 待判定既不在分子也不在分母：它是"还没判"，不是"判过了"。
  const pendingReview = metrics.sample.pendingReview;
  const decisions = data.weekly?.decisions ?? [];
  // 叙事来自身份为 (user, type, period) 的最近一份周复盘，指标卡却是本周现算的：
  // 跨周之后没重跑时，这张卡必须说清自己是哪一周的，不能顶着「本周」两个字。
  const narrative = weeklyNarrativeState({
    period: data.weekly?.period ?? null,
    currentWeekKey: metrics.weekKey,
    hasNarrative: Boolean(data.weekly?.narrative),
  });

  const metricCards: Array<{ label: string; value: string; hint: string }> = [
    {
      label: "学习时长",
      value: `${metrics.studyMinutes}m`,
      hint: "按本周已封存 check-in 计。",
    },
    {
      label: "回忆正确率",
      value:
        metrics.recallAvg === null
          ? "—"
          : `${Math.round(metrics.recallAvg * 100)}%`,
      hint: recallAverageHint(metrics.recallAvg),
    },
    {
      label: "学习任务",
      value: String(metrics.learningTasks),
      hint: "本周验收通过的学习类任务数。",
    },
    {
      label: "目标进度",
      value:
        metrics.goalProgress === null
          ? "—"
          : `${metrics.goalProgress.toFixed(0)}%`,
      hint:
        metrics.goalProgress === null
          ? "没有活跃的学习目标，暂不计算。"
          : "估算：任务验收 + 回忆分 + 打卡数加权，非实测。",
    },
    {
      label: "每周自主行动",
      value: String(metrics.aao),
      hint: "本周被接受的自主结果数。",
    },
    {
      label: "审计驳回",
      value:
        metrics.auditRejectRate === null
          ? "—"
          : `${metrics.auditRejectRate.toFixed(0)}%`,
      hint:
        metrics.auditRejectRate === null
          ? pendingReview > 0
            ? `本周有 ${pendingReview} 条停在你这里，还没有可计算的样本。`
            : "本周没有审计样本，暂不计算。"
          : `驳回 ${metrics.sample.rejects} / 审计 ${auditSamplesThisWeek} 条` +
            (pendingReview > 0 ? `，另有 ${pendingReview} 条待你判定。` : "。"),
    },
  ];

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-eyebrow font-medium uppercase tracking-[0.2em] text-faint">
            <ClipboardCheck className="size-3 text-accent" />
            Review · {metrics.weekKey}
          </div>
          <h1 className="text-page font-semibold tracking-tight text-ink">周复盘</h1>
          <p className="mt-1.5 text-label text-muted">
            这一页回答四件事：发生了什么、哪些结论站得住、下周做什么、去哪里回溯原始记录。
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

      {/* 01 — 本周发生了什么 */}
      <Section
        index="01"
        title="本周发生了什么"
        hint="先看事实，再看解读。指标是这一周的原始计数；叙事由规则脚本汇总这些计数写成，不是模型生成。"
      >
        <Card>
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 px-5 py-4 sm:grid-cols-3 lg:grid-cols-6">
            {metricCards.map((metric) => (
              <Stat
                key={metric.label}
                label={metric.label}
                value={metric.value}
                hint={metric.hint}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-start gap-2 border-t border-line px-5 py-3 text-label text-faint">
            <span className="text-muted">口径：</span>
            <span>
              学习时长与回忆分来自 check-in；目标进度是加权估算值；审计驳回的分母是本周审计样本，不是任务总数。
            </span>
            <span>指标为空时显示「—」，不填 0。</span>
          </div>
        </Card>

        <Card className="mt-5">
          <CardHeader
            eyebrow="Narrative"
            title={narrative.title}
            right={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Badge tone="neutral" title="由 regenerateWeeklyReview 规则脚本按本周指标拼接，没有调用模型">
                  <FileCode2 className="size-2.5" /> 由规则脚本生成，需人工判断
                </Badge>
                <span className="text-label text-faint">
                  {dateTime(data.weekly?.createdAt, tz)}
                </span>
              </div>
            }
          />
          <div className="px-5 py-4">
            {narrative.stale ? (
              <p className="mb-3 rounded-md border border-line bg-panel2 px-3 py-2 text-label leading-relaxed text-muted">
                {narrative.note}
              </p>
            ) : null}
            {data.weekly?.narrative ? (
              <Markdown content={data.weekly.narrative} />
            ) : (
              <EmptyState
                title="本周还没有生成复盘叙事"
                hint="叙事由规则脚本把本周的指标和完成情况套进固定模板写成，因此只覆盖脚本读到的字段。点击右上角「生成本周复盘」可以重跑一次。"
                icon={<FileClock className="size-4" />}
              />
            )}
          </div>
          <div className="border-t border-line px-5 py-3 text-label text-faint">
            这段文字由规则脚本按模板生成，不是模型判断，也不是审计结论：数字以上方指标和 04 区的审计记录为准。
          </div>
        </Card>

        <Card className="mt-5">
          <CardHeader
            eyebrow="Diff"
            title="本周改了什么"
            right={<GitCompareArrows className="size-3.5 text-faint" />}
          />
          <div className="divide-y divide-line">
            {decisions.map((decision, i) => (
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
            {decisions.length === 0 && data.insightAppliedTotal === 0 ? (
              <div className="px-5 py-6 text-label text-muted">
                {/* `decisions` 目前恒为空：`reviews.ts:115`/`:134` 与 `brief.ts:37`/`:41`
                    都写死 `decisions: []`，只有 seed 里非空。所以这里只承诺"采纳洞察"
                    这一条真实存在的写入路径；若将来接入任务变更记录，这句和上面的
                    `decisions.map` 要一起改。 */}
                本周没有已生效的变更。复盘时采纳一条洞察，这里就会多一行。
              </div>
            ) : null}
            {data.insightAppliedTotal > applied.length ? (
              <div className="px-5 py-3 text-label text-faint">
                本周共 {data.insightAppliedTotal} 条已生效的变更，这里只列最新的 {applied.length} 条。
              </div>
            ) : null}
          </div>
        </Card>
      </Section>

      {/* 02 — 哪些结论站得住 */}
      <Section
        index="02"
        title="哪些结论站得住"
        hint="每条结论都要能点回证据。样本不足的地方会直接写出来，不用颜色代替说明。"
      >
        <div className="grid gap-5 lg:grid-cols-[1.7fr_1fr]">
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
            {insightPage !== "ok" ? (
              insightPage === "empty" ? (
                <EmptyState
                  title="本周没有产生新洞察"
                  hint="洞察来自对本周执行信号的反思。样本太少或信号不足时不会硬造结论；可以先跑一次「运行反思」，或先完成几条任务的验收。"
                  icon={<ScanSearch className="size-4" />}
                />
              ) : (
                <EmptyState
                  title="这一页没有洞察"
                  hint={`共 ${data.insightTotal} 条，这一页从第 ${data.insightOffset + 1} 条开始，已经越过末尾。`}
                  icon={<ScanSearch className="size-4" />}
                  action={
                    <Link
                      href={pageHref({ insightOffset: 0 })}
                      className="inline-flex items-center gap-1 text-label text-muted hover:text-ink"
                    >
                      回到第一页 <ChevronRight className="size-3" />
                    </Link>
                  }
                />
              )
            ) : (
              <div className="space-y-3">
                {data.insights.map((insight) => (
                  <InsightCard key={insight.id} insight={insight} />
                ))}
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-label text-faint">
              <span>
                {insightPage === "ok"
                  ? `第 ${data.insightOffset + 1}–${data.insightOffset + data.insights.length} 条 / 共 ${data.insightTotal}`
                  : `共 ${data.insightTotal} 条`}
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
            {data.insights.length > 0 ? (
              <div className="mt-3 flex items-start gap-1.5 text-label text-faint">
                <Sparkles className="mt-0.5 size-3 shrink-0" />
                <span>
                  洞察条目由规则脚本按阈值命中生成（不是模型生成），置信度是脚本里写死的配置值，不是统计显著性；采纳前请逐条点开证据核对。
                </span>
              </div>
            ) : null}
          </div>

          <div className="space-y-5">
            <Card>
              <CardHeader
                eyebrow="Agent performance"
                title="内阁绩效"
                right={
                  zeroSampleAgents > 0 ? (
                    <Badge tone="neutral">{zeroSampleAgents} 个样本不足</Badge>
                  ) : null
                }
              />
              <div className="divide-y divide-line">
                {data.agents.length === 0 ? (
                  <div className="px-5 py-6 text-center text-label text-faint">
                    还没有 Agent。创建工作区后，这里会按信任分给出升级或退休建议。
                  </div>
                ) : null}
                {data.agents.map((agent) => {
                  const rate = passRate(agent.successCount, agent.failCount);
                  const verdicts = agent.successCount + agent.failCount;
                  const samples = data.auditStats[agent.id]?.total ?? 0;
                  const rec = recommendation(
                    agent,
                    data.autonomyDecisions[agent.id],
                  );
                  const meta = roleMeta(agent.role);
                  return (
                    <Link
                      key={agent.id}
                      href={`/cabinet/${agent.id}`}
                      className="block px-5 py-3 transition-colors hover:bg-white/[0.02]"
                    >
                      <div className="flex items-center gap-2.5">
                        <Avatar initials={agent.avatar} accent={meta.accent} size={28} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-label text-ink">{agent.name}</div>
                          <div className="text-label text-faint">
                            {/*
                              Two different denominators live here, so say which
                              is which: this percentage is the agent's whole
                              history, while the promotion badge below is judged
                              on eligible audit samples only. Printing 92% next
                              to "0 个样本" without the word 历史 reads as a bug.
                            */}
                            {verdicts === 0
                              ? "还没有验收记录"
                              : `历史通过率 ${rate}%（${agent.successCount} 通过 / ${agent.failCount} 驳回）`}
                            {` · L${agent.autonomyLevel}`}
                          </div>
                        </div>
                        <span title={rec.title}>
                          <Badge tone={rec.tone}>{rec.label}</Badge>
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-start gap-1.5 pl-[38px] text-label text-faint">
                        <Bot className="mt-0.5 size-3 shrink-0" />
                        <span>
                          {samples === 0
                            ? "有效审计样本 0 个 · 样本不足，结论仅供参考"
                            : `有效审计样本 ${samples} 个 · 样本越多结论越稳`}
                        </span>
                      </div>
                      {samples > 0 ? (
                        <Progress
                          label={`${agent.name} 的审计通过率`}
                          value={(data.auditStats[agent.id]?.passRate ?? 0) * 100}
                          tone="teal"
                          className="mt-2 h-1"
                        />
                      ) : null}
                    </Link>
                  );
                })}
              </div>
              <div className="border-t border-line px-5 py-3 text-label text-faint">
                升级与退休结论由后端按审计样本判定，这里只展示它的结论；徽标旁的数字是它实际用到的样本量。
                「已达上限」「维持当前等级」是本页自己比较等级得出的：后端在同级变更时仍会返回「允许」，因为同级变更是允许的。
              </div>
            </Card>

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
              {dissentPage !== "ok" ? (
                <div className="px-5 py-4">
                  {dissentPage === "empty" ? (
                    <EmptyState
                      title="本周没有产生异议"
                      hint="异议在你批准一场存在反对立场的内阁决议时产生；进入观察期后，按条件窗口重新评估，才有平反或证伪。"
                      icon={<ListTree className="size-4" />}
                      action={
                        <Link
                          href="/council"
                          className="inline-flex items-center gap-1 text-label text-muted hover:text-ink"
                        >
                          去议会查看讨论 <ChevronRight className="size-3" />
                        </Link>
                      }
                    />
                  ) : (
                    <EmptyState
                      title="这一页没有异议"
                      hint={`共 ${data.dissentTotal} 条，这一页从第 ${data.dissentOffset + 1} 条开始，已经越过末尾。`}
                      icon={<ListTree className="size-4" />}
                      action={
                        <Link
                          href={pageHref({ dissentOffset: 0 })}
                          className="inline-flex items-center gap-1 text-label text-muted hover:text-ink"
                        >
                          回到第一页 <ChevronRight className="size-3" />
                        </Link>
                      }
                    />
                  )}
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
                          {/* 条件是「7 天内支出 ≥ ¥480.00」这种人话：metric 是内部键，
                              阈值带的是那个键的单位（分），原样印出来会把 ¥480 说成 48000。 */}
                          <span className="text-label text-faint">
                            {dissentConditionText(dissent.condition)}
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
                            : " · 暂无证据"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3 text-label text-faint">
                <span>
                  {dissentPage === "ok"
                    ? `第 ${data.dissentOffset + 1}–${data.dissentOffset + data.dissents.length} 条 / 共 ${data.dissentTotal}`
                    : `共 ${data.dissentTotal} 条`}
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
          </div>
        </div>
      </Section>

      {/* 03 — 下周做什么 */}
      <Section
        index="03"
        title="下周做什么"
        hint="只承诺一件事。目标是可被下周复盘检验的，所以这里挑的是还没收尾、优先级最高的任务。"
      >
        <Card className="border-teal/20 bg-teal/[0.03]">
          <div className="flex items-start gap-3 px-5 py-4">
            <TrendingUp className="mt-0.5 size-4 text-teal" />
            <div className="min-w-0">
              <div className="text-label font-medium text-ink">下一周的唯一目标</div>
              {focus ? (
                <p className="mt-1 text-label leading-relaxed text-muted">
                  <Link href={`/tasks/${focus.id}`} className="text-ink hover:underline">
                    {focus.title}
                  </Link>
                  {` · 优先级 P${focus.priority}`}
                  {focus.dueAt ? ` · 截止 ${shortDate(focus.dueAt, tz)}` : ""}
                </p>
              ) : (
                <p className="mt-1 text-label leading-relaxed text-muted">
                  没有未收尾的任务。可以从「洞察与变更」里采纳一条变更，给下周定一个具体目标。
                </p>
              )}
              <p className="mt-1 text-label text-faint">
                这个目标由未收尾任务的优先级和截止日期挑出，是建议而不是承诺；改任务安排后它会跟着变。
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {focus ? (
                  <Link
                    href={`/tasks/${focus.id}`}
                    className="inline-flex items-center gap-1 text-label text-teal hover:underline"
                  >
                    打开这个任务 <ArrowRight className="size-3" />
                  </Link>
                ) : null}
                <Link
                  href="/cabinet"
                  className="inline-flex items-center gap-1 text-label text-teal hover:underline"
                >
                  查看 Agent 绩效 <ArrowRight className="size-3" />
                </Link>
              </div>
            </div>
          </div>
        </Card>
        {/* 掌握度挂在 03 里而不是新开一段：它回答的是"哪种东西该复习了"，
            和"下周做哪一件事"同属下一步动作；单独开一段会把这个只有一张
            卡片的东西，抬成和"本周结论"同级的主题。 */}
        <div className="mt-5">
          <MasteryCard timezone={tz} />
        </div>
      </Section>

      {/* 04 — 回溯原始记录 */}
      <Section
        index="04"
        title="回溯原始记录"
        hint="上面每一条结论都能落到下面这些原始记录上：审计事件、任务详情、Agent 档案、议会讨论。"
      >
        <div className="grid gap-5 lg:grid-cols-[1.7fr_1fr]">
          <Card>
            <CardHeader
              eyebrow="Audit trail"
              title="审计日志"
              right={<VerifyAuditButton />}
            />
            <div className="divide-y divide-line">
              {data.audit.length === 0 ? (
                <div className="px-5 py-4">
                  <EmptyState
                    title="还没有审计记录"
                    hint="第一次验收通过后，这里会写下第一条哈希链事件。没有事件不代表没有风险，只代表还没有可审计的动作。"
                    icon={<FileClock className="size-4" />}
                  />
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
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-2.5 text-label text-faint">
              <span>
                哈希链：每条记录包含前一条的 hash，改动可被发现。共 {data.auditTotal} 条，此处显示最近 8 条。
              </span>
              <Link
                href="/review/audit"
                className="inline-flex items-center gap-1 text-muted hover:text-ink"
              >
                查看全部 <ArrowRight className="size-3" />
              </Link>
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Sources" title="回溯入口" />
            <div className="divide-y divide-line">
              {[
                {
                  href: "/review/audit",
                  label: "审计记录全量",
                  hint: `共 ${data.auditTotal} 条，可按类型筛选`,
                  icon: ShieldCheck,
                },
                {
                  href: "/cabinet",
                  label: "Agent 档案与绩效",
                  hint: `${data.agents.length} 个 Agent 的信任分与判例`,
                  icon: Bot,
                },
                {
                  href: "/council",
                  label: "议会讨论",
                  hint: "异议与判例的提出场景",
                  icon: ListTree,
                },
                {
                  href: "/memory",
                  label: "记忆与证据",
                  hint: "结论引用过的原始材料",
                  icon: ScanSearch,
                },
              ].map((entry) => {
                const Icon = entry.icon;
                return (
                  <Link
                    key={entry.href}
                    href={entry.href}
                    className="flex items-center gap-2.5 px-5 py-3 transition-colors hover:bg-white/[0.02]"
                  >
                    <Icon className="size-3.5 shrink-0 text-faint" />
                    <div className="min-w-0 flex-1">
                      <div className="text-label text-ink">{entry.label}</div>
                      <div className="truncate text-label text-faint">{entry.hint}</div>
                    </div>
                    <ExternalLink className="size-3 shrink-0 text-faint" />
                  </Link>
                );
              })}
              {focus ? (
                <Link
                  href={`/tasks/${focus.id}`}
                  className="flex items-center gap-2.5 px-5 py-3 transition-colors hover:bg-white/[0.02]"
                >
                  <ClipboardCheck className="size-3.5 shrink-0 text-faint" />
                  <div className="min-w-0 flex-1">
                    <div className="text-label text-ink">本周聚焦任务</div>
                    <div className="truncate text-label text-faint">{focus.title}</div>
                  </div>
                  <ExternalLink className="size-3 shrink-0 text-faint" />
                </Link>
              ) : null}
            </div>
            <div className="flex items-start gap-1.5 border-t border-line px-5 py-3 text-label text-faint">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              <span>
                本页指标来自本周快照，任务和审计记录会继续变动；对不上时以这些原始记录为准。
              </span>
            </div>
          </Card>
        </div>
      </Section>
    </div>
  );
}