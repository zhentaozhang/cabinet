import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Brain,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Gavel,
  Layers,
  ShieldCheck,
  Sparkles,
  Sun,
} from "lucide-react";
import { fetchTodayPage } from "@/lib/api/pages";
import { roleMeta } from "@/lib/agents";
import { dateTime, money, pct, timeOnly } from "@/lib/format";
import {
  countPendingDecisions,
  getProvenanceLabel,
  getTaskTypeLabel,
  pickLearningTask,
  pickTopSpender,
  weeklyMetricRows,
} from "@/lib/presentation/today-view";
import {
  Badge,
  Card,
  CardHeader,
  Dot,
  EmptyState,
  Progress,
  Stat,
  StatusBadge,
} from "@/components/ui";
import {
  ApprovalActions,
  BriefButton,
  CheckinForm,
  NextLearningTaskButton,
  QuickCreate,
} from "@/components/actions";
import { Markdown } from "@/components/markdown";

export const metadata: Metadata = {
  title: "Today · Cabinet",
};

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const data = await fetchTodayPage();
  const tz = data.user.timezone;
  const primaryGoal = data.goals[0];
  const topSpender = pickTopSpender(data.agents);
  const agentById = new Map(data.agents.map((a) => [a.id, a]));
  const today = new Intl.DateTimeFormat("zh-CN", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: tz,
  }).format(new Date());

  const pendingCount = countPendingDecisions(data);

  const learningTask = pickLearningTask(data.tasks);

  const brief =
    data.brief?.narrative ??
    `# 今日早报\n\n目标：${data.goals.map((g) => `${g.title}（${pct(g.progress)}）`).join(" · ")}\n\n## 今天的关键判断\n- 今天有 ${data.tasks.length} 个待推进任务。\n- 有 ${data.approvals.length} 个决定等你。`;

  const weekly = data.weeklyMetrics;
  const metricRows = weeklyMetricRows(weekly);

  return (
    <div className="pb-16">
      {/* 行动首页顶栏 */}
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-eyebrow font-medium uppercase tracking-[0.2em] text-faint">
            <Sun className="size-3 text-accent" />
            Today · {today}
          </div>
          <h1 className="text-page font-semibold tracking-tight text-ink">
            早上好，{data.user.name}
          </h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-label text-muted">
            <span className="mono">{data.weeklyMetrics.weekKey}</span>
            <span>·</span>
            <span>
              {primaryGoal
                ? `目标：${primaryGoal.title} (${pct(primaryGoal.progress)})`
                : "尚未设定目标"}
            </span>
            <span>·</span>
            <span className="text-ink font-medium">
              {data.tasks.length} 项任务推进中
            </span>
            {pendingCount > 0 ? (
              <>
                <span>·</span>
                <span className="text-accent font-medium">
                  {pendingCount} 项待决策
                </span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-eyebrow uppercase tracking-[0.16em] text-faint">
              study / week
            </div>
            <div className="mono text-emphasis text-teal">
              {data.weeklyMetrics.studyMinutes} min
            </div>
          </div>
          <div className="h-8 w-px bg-line" />
          <div className="text-right">
            <div className="text-eyebrow uppercase tracking-[0.16em] text-faint">
              recall
            </div>
            <div className="mono text-emphasis text-accent">
              {data.weeklyMetrics.recallAvg === null
                ? "—"
                : `${Math.round(data.weeklyMetrics.recallAvg * 100)}%`}
            </div>
          </div>
        </div>
      </div>

      {/*
        Priority 1 is always rendered, including when nothing is waiting. A card
        that silently disappears leaves the reader unsure whether the queue is
        empty or the page failed to load it — the empty state says which.
      */}
      <Card variant={pendingCount > 0 ? "decision" : "default"} className="mb-6">
        <CardHeader
          eyebrow="需要你决定"
          title="现在需要我处理"
          right={
            pendingCount > 0 ? (
              <Badge tone="accent">{pendingCount} 项待处理</Badge>
            ) : (
              <Badge tone="neutral">当前没有待办</Badge>
            )
          }
        />
        {pendingCount === 0 ? (
          <div className="px-5 py-6">
            <EmptyState
              title="没有需要你决定的事"
              hint="审批、内阁决议和驳回后待修改的任务都会出现在这里。Agent 推进到需要人工放行的动作时会主动停下并提醒你。"
              action={
                <Link
                  href="/cabinet"
                  className="inline-flex items-center gap-1.5 rounded-md border border-line2 bg-panel2 px-3 py-1.5 text-label text-ink transition-colors hover:border-line2/80 hover:bg-panel-hover"
                >
                  查看内阁分工
                  <ArrowRight className="size-3" aria-hidden="true" />
                </Link>
              }
            />
          </div>
        ) : (
          <div className="divide-y divide-line">
            {data.approvals.map((approval) => {
              const payload = approval.payload;
              const title = String(
                payload.title ?? payload.provider ?? "待批准动作",
              );
              const at =
                typeof payload.dueAt === "string"
                  ? dateTime(payload.dueAt, tz)
                  : String(payload.time ?? "");
              const reason = String(payload.reason ?? payload.note ?? "");
              const costCents = Number(
                payload.estimatedCostCents ?? payload.costCents ?? 0,
              );
              return (
                <div key={approval.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      <CircleAlert className="mt-0.5 size-4 shrink-0 text-accent" />
                      <div className="min-w-0">
                        <div className="text-label font-semibold text-ink">
                          {title} {at ? `· ${at}` : ""}
                        </div>
                        <div className="mt-1 text-label text-muted">
                          {reason ? <span>{reason} · </span> : null}
                          <span className="mono text-ink">
                            预计 ¥{(costCents / 100).toFixed(2)}
                          </span>
                        </div>
                      </div>
                    </div>
                    <ApprovalActions
                      approvalId={approval.id}
                      actionType={approval.action}
                    />
                  </div>
                </div>
              );
            })}

            {data.council ? (
              <Link
                href="/council"
                className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-white/[0.02]"
              >
                <Gavel className="size-4 shrink-0 text-violet" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-label font-semibold text-ink">
                    内阁会议：{data.council.topic}
                  </div>
                  <div className="mt-1 text-label text-faint">
                    触发：{data.council.trigger}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-label font-medium text-violet">
                  <span>进入决策室</span>
                  <ArrowRight className="size-3.5" />
                </div>
              </Link>
            ) : null}
          </div>
        )}
      </Card>

      {/* Priority 2: "推荐的下一步" (Coach / Recommended Next Step) */}
      <Card variant="elevated" className="mb-6 border-accent/30 bg-panel-raised/95">
        <CardHeader
          eyebrow="推荐下一步"
          title={primaryGoal ? `围绕「${primaryGoal.title}」的下一步` : "推荐的下一步"}
          right={<NextLearningTaskButton />}
        />
        <div className="p-5">
          {learningTask ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-line2/70 bg-panel2/60 p-4 transition-colors hover:border-accent/40">
              <div className="flex items-start gap-3.5 min-w-0">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-accent/40 bg-accent/15 text-accent shadow-[0_0_12px_-2px_rgba(226,163,54,0.25)]">
                  <Brain className="size-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-emphasis font-semibold text-ink">
                      {learningTask.title}
                    </span>
                    <StatusBadge status={learningTask.status} />
                    <Badge tone="neutral">
                      {learningTask.template === "learning_retest" ? "间隔复测" : "针对性学习"}
                    </Badge>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-3 text-label text-faint">
                    <span className="inline-flex items-center gap-1 text-muted">
                      <Clock3 className="size-3" /> 预计 {learningTask.estimateMin} 分钟
                    </span>
                    {learningTask.dueAt ? (
                      <>
                        <span>·</span>
                        <span>截止 {timeOnly(learningTask.dueAt, tz)}</span>
                      </>
                    ) : null}
                    {learningTask.description ? (
                      <>
                        <span>·</span>
                        <span className="truncate max-w-xs text-faint">
                          {learningTask.description}
                        </span>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="shrink-0 sm:pl-2">
                <Link
                  href={`/tasks/${learningTask.id}`}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-label font-semibold text-accent-ink shadow-sm transition-all hover:bg-accent-hi hover:scale-[1.02] active:scale-[0.98]"
                >
                  <span>立即开始</span>
                  <ArrowRight className="size-3.5" />
                </Link>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line2/60 bg-panel2/30 px-6 py-8 text-center">
              <Brain className="size-8 text-accent/60 mb-2" />
              <div className="text-label font-medium text-ink">还没有进行中的学习任务</div>
              <p className="mt-1 max-w-md text-label text-muted">
                Coach 可以根据你的知识网络与记忆召回率，为你安排针对性巩固与新内容学习。
              </p>
              <div className="mt-4">
                <NextLearningTaskButton />
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Priority 3: "今天的进展" (Today's Tasks & Active Progress) */}
      <Card className="mb-8">
        <CardHeader
          eyebrow="今天的进展"
          title="今天的任务与进展"
          right={
            <div className="flex items-center gap-3">
              <Badge tone="neutral">{data.tasks.length} 项进行中</Badge>
              <Link
                href="/cabinet"
                className="flex items-center gap-1 text-label text-muted transition-colors hover:text-ink"
              >
                内阁分工 <ArrowRight className="size-3" />
              </Link>
            </div>
          }
        />
        {data.tasks.length > 0 ? (
          <div className="divide-y divide-line">
            {data.tasks.map((task) => {
              const agent = task.assigneeId ? agentById.get(task.assigneeId) : null;
              const typeLabel = getTaskTypeLabel(task);
              const provenanceLabel = getProvenanceLabel(task.createdBy);

              return (
                <Link
                  key={task.id}
                  href={`/tasks/${task.id}`}
                  className="group flex items-center gap-3.5 px-5 py-3.5 transition-colors hover:bg-white/[0.02]"
                >
                  <Dot
                    tone={
                      task.status === "failed" || task.status === "cancelled"
                        ? "danger"
                        : task.status === "awaiting_approval" || task.status === "auditing"
                          ? "accent"
                          : task.status === "done" || task.status === "accepted"
                            ? "teal"
                            : "muted"
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-label font-medium text-ink group-hover:text-accent transition-colors">
                        {task.title}
                      </span>
                      <span className="rounded border border-line bg-panel2/60 px-1.5 py-0.5 text-[10px] text-faint">
                        {provenanceLabel}
                      </span>
                      <span className="rounded border border-line bg-panel2/60 px-1.5 py-0.5 text-[10px] text-muted">
                        {typeLabel}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-label text-faint">
                      <span className="text-muted font-medium">
                        {agent ? agent.name : "未指派"}
                      </span>
                      <span>·</span>
                      <span className="inline-flex items-center gap-1">
                        <Clock3 className="size-2.5" /> {task.estimateMin} min
                      </span>
                      {task.dueAt ? (
                        <>
                          <span>·</span>
                          <span>截止 {timeOnly(task.dueAt, tz)}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <StatusBadge status={task.status} />
                    <ArrowRight className="size-3.5 text-faint group-hover:text-muted transition-colors" />
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="px-5 py-10">
            <EmptyState
              title="今天暂无待推进任务"
              hint="内阁成员目前都在就绪状态。你可以让 Coach 规划学习任务，或在下方快速创建新任务。"
              action={
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <NextLearningTaskButton />
                  <Link
                    href="/cabinet"
                    className="inline-flex items-center justify-center gap-1.5 rounded-md border border-line2 bg-panel2 px-3 py-1.5 text-label text-ink transition-colors hover:bg-panel-hover"
                  >
                    前往内阁指派
                  </Link>
                </div>
              }
            />
          </div>
        )}
      </Card>

      {/* Priority 4: "补充与回顾信息" (Context & Metrics底座) */}
      <div className="mt-12 border-t border-line/80 pt-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-eyebrow font-medium tracking-[0.18em] text-faint">
              <Layers className="size-3 text-muted" />
              背景与回顾
            </div>
            <h2 className="mt-1 text-section font-semibold tracking-tight text-ink">
              补充与回顾信息
            </h2>
            <p className="mt-1 text-label text-muted">
              提供背景早报、每日状态反馈、周度指标与资源消耗核算底座
            </p>
          </div>
          <div className="mono text-label text-faint">
            {data.weeklyMetrics.weekKey}
          </div>
        </div>

        {/* 支出核算：模型消耗 vs 搜索消耗并列排布 */}
        <Card className="mb-6">
          <CardHeader
            eyebrow="Spend & Cost Breakdown"
            title="资源消耗与核算"
            right={<Badge tone="neutral">{weekly.weekKey}</Badge>}
          />
          <div className="grid grid-cols-1 divide-y divide-line md:grid-cols-2 md:divide-y-0 md:divide-x">
            {/* 模型推理费用 */}
            <div className="p-5">
              <div className="flex items-center justify-between">
                <div className="text-label font-medium uppercase tracking-[0.14em] text-faint">
                  模型推理费用 (Model Tokens)
                </div>
                <Badge tone={weekly.costCents > 0 ? "accent" : "neutral"}>
                  按 Token 计量
                </Badge>
              </div>
              <div className="mt-2 text-page font-semibold tracking-tight text-ink tabular-nums font-mono">
                {weekly.costCents > 0 ? money(weekly.costCents) : "¥0.00"}
              </div>
              <p className="mt-1.5 text-label text-muted">
                {topSpender
                  ? `主要消耗者：${topSpender.name}（${money(topSpender.spentCents)}）`
                  : "本周还没有产生模型费用"}
              </p>
              <div className="mt-2 text-label text-faint">
                {data.agents.length} 位内阁 Agent 共同分担
              </div>
            </div>

            {/* 外部检索调用 */}
            <div className="p-5">
              <div className="flex items-center justify-between">
                <div className="text-label font-medium uppercase tracking-[0.14em] text-faint">
                  外部检索调用 (Search / Retrieval)
                </div>
                <Badge tone={weekly.search.requests > 0 ? "teal" : "neutral"}>
                  按 Request 计量
                </Badge>
              </div>
              <div className="mt-2 text-page font-semibold tracking-tight text-ink tabular-nums font-mono">
                {weekly.search.requests} <span className="text-emphasis font-normal text-muted">次请求</span>
              </div>
              <p className="mt-1.5 text-label text-muted">
                {weekly.search.requests === 0
                  ? "本周暂无外部检索调用"
                  : weekly.search.unpricedRequests === 0
                    ? `检索费用 ${money(weekly.search.estimatedCents)}（按调用时单价）`
                    : weekly.search.unpricedRequests === weekly.search.requests
                      ? "本周检索未计价（部署未配置单价）"
                      : `已计价 ${money(weekly.search.estimatedCents)}，另有 ${weekly.search.unpricedRequests} 次未计价`}
              </p>
              <div className="mt-2 text-label text-faint">
                Token 消耗与外部检索属于两条独立曲线，并列展示不相加
              </div>
            </div>
          </div>
        </Card>

        {/* 周度指标概览 */}
        <Card className="mb-6">
          <CardHeader
            eyebrow="Weekly Metrics"
            title="每周关键指标概览"
            right={<span className="text-label text-faint">周跨度总览</span>}
          />
          <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-3 lg:grid-cols-6">
            {metricRows.map((row) => (
              <Stat
                key={row.key}
                label={row.label}
                value={row.value}
                hint={row.hint}
              />
            ))}
          </div>
        </Card>

        {/* 早报与 Check-in 并排展示 */}
        <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-[1.55fr_1fr]">
          {/* 左侧：今日早报 */}
          <Card>
            <CardHeader
              eyebrow="Morning Brief · Atlas"
              title="今天的关键判断"
              right={<BriefButton />}
            />
            <div className="px-5 py-4">
              <Markdown content={brief} />
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
              <Badge tone="teal">
                <ShieldCheck className="size-2.5" /> 基于 {data.tasks.length} 个进行中的任务
              </Badge>
              <Badge tone="accent">
                <Sparkles className="size-2.5" /> {data.counts.proposedInsights} 条洞察待采纳
              </Badge>
              <span className="ml-auto text-label text-faint">
                生成于 {dateTime(data.brief?.createdAt, tz)}
              </span>
            </div>
          </Card>

          {/* 右侧：Check-in & 昨天的偏差 */}
          <div className="space-y-6">
            <Card>
              <CardHeader eyebrow="Check-in" title="今天感觉如何？" />
              <div className="px-5 py-4">
                {data.checkin ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-label text-teal">
                      <CheckCircle2 className="size-3.5" /> 今天已 check-in
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Stat label="Energy" value={`${data.checkin.energy}/5`} />
                      <Stat label="Mood" value={`${data.checkin.mood}/5`} />
                      <Stat
                        label="学习"
                        value={`${data.checkin.studyMinutes} min`}
                      />
                      <Stat
                        label="回忆"
                        value={
                          data.checkin.recallScore === null
                            ? "—"
                            : `${Math.round(data.checkin.recallScore * 100)}%`
                        }
                      />
                    </div>
                    {data.checkin.errorTags.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {data.checkin.errorTags.map((tag) => (
                          <Badge key={tag} tone="danger">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                    <div className="rounded-md border border-line bg-panel2/50 px-3 py-2 text-label text-muted">
                      {data.checkin.note || "无备注"}
                    </div>
                  </div>
                ) : (
                  <CheckinForm
                    tasks={data.tasks.map((t) => ({ id: t.id, title: t.title }))}
                  />
                )}
              </div>
            </Card>

            <Card>
              <CardHeader eyebrow="Yesterday" title="昨天的偏差" />
              <div className="px-5 py-4">
                {data.yesterdayCheckin ? (
                  <div className="flex flex-wrap items-center gap-4">
                    <div className="flex items-center gap-2 text-label text-muted">
                      <span className="mono text-ink">
                        {data.yesterdayCheckin.energy}/5
                      </span>{" "}
                      精力
                      <span className="text-line2">·</span>
                      <span className="mono text-ink">
                        {data.yesterdayCheckin.mood}/5
                      </span>{" "}
                      心情
                    </div>
                    <div className="text-label text-muted">
                      {
                        data.yesterdayCheckin.completed.filter((c) => !c.done)
                          .length
                      } 项未完成
                    </div>
                    <div className="basis-full text-label text-muted">
                      “{data.yesterdayCheckin.note}”
                    </div>
                    <Badge tone="teal">
                      <CheckCircle2 className="size-2.5" /> 已写入记忆
                    </Badge>
                  </div>
                ) : (
                  <div className="text-label text-faint">还没有昨天的 check-in。</div>
                )}
              </div>
            </Card>
          </div>
        </div>

        {/* 目标进度、Agent 动态与快速创建 */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card>
            <CardHeader eyebrow="Goals" title="目标进度" />
            <div className="space-y-4 px-5 py-4">
              {data.goals.map((goal) => (
                <div key={goal.id}>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-label text-ink">{goal.title}</span>
                    <span className="mono text-label text-muted">
                      {pct(goal.progress)}
                    </span>
                  </div>
                  <Progress
                    label={`${goal.title} 的目标进度`}
                    value={goal.progress}
                    tone={goal.domain === "health" ? "teal" : "accent"}
                  />
                  <div className="mt-1 text-label text-faint">{goal.target}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Cabinet Pulse" title="Agent 动态" />
            <div className="divide-y divide-line">
              {data.agents.slice(0, 5).map((agent) => {
                const meta = roleMeta(agent.role);
                return (
                  <Link
                    key={agent.id}
                    href={`/cabinet/${agent.id}`}
                    className="flex items-center gap-2.5 px-5 py-2.5 transition-colors hover:bg-white/[0.02]"
                  >
                    <span
                      className="flex size-6 items-center justify-center rounded-md border font-mono text-label"
                      style={{
                        color: meta.accent,
                        borderColor: `${meta.accent}55`,
                        background: `${meta.accent}14`,
                      }}
                    >
                      {agent.avatar}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-label text-ink">
                        {agent.name}
                      </div>
                      <div className="text-label text-faint">{meta.objective}</div>
                    </div>
                    <div className="text-right">
                      <div className="mono text-label text-muted">
                        L{agent.autonomyLevel}
                      </div>
                      <div className="text-label text-faint">
                        {Math.round(agent.trustScore)}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader eyebrow="Create" title="快速创建" />
              <div className="px-5 py-4">
                <QuickCreate
                  agents={data.agents.map((agent) => ({
                    id: agent.id,
                    name: agent.name,
                    role: agent.role,
                  }))}
                  goals={data.goals.map((goal) => ({
                    id: goal.id,
                    title: goal.title,
                  }))}
                />
              </div>
            </Card>

            <Card className="border-accent/20 bg-accent/[0.03]">
              <div className="flex items-start gap-3 px-5 py-4">
                <Brain className="mt-0.5 size-4 shrink-0 text-accent" />
                <div>
                  <div className="text-label font-medium text-ink">每天 3 分钟闭环</div>
                  <p className="mt-1 text-label leading-relaxed text-muted">
                    早报 1 分钟、check-in 30 秒、审批 1 分钟。其余执行交给内阁。
                  </p>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
