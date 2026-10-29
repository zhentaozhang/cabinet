import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Brain,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileCode2,
  Gavel,
  Inbox,
  Layers,
  ShieldCheck,
  Sparkles,
  Sun,
} from "lucide-react";
import { fetchTodayPage } from "@/lib/api/pages";
import { roleMeta } from "@/lib/agents";
import type { GoalDto } from "@/contracts";
import { goalStatusLabel } from "@/contracts/labels";
import { cn, dateTime, money, timeOnly } from "@/lib/format";
import { goalProgressHint, goalProgressText } from "@/lib/presentation/goal-view";
import { checkinMemoryContent } from "@/lib/domain/checkin-memory";
import { assigneeBlockReason } from "@/lib/domain/policy";
import {
  briefDecisionLine,
  briefFreshness,
  briefGoalLine,
  briefTaskLine,
} from "@/lib/presentation/brief-view";
import { localDateKey } from "@/lib/domain/time";
import {
  briefTaskSnapshot,
  buildTodayActionQueue,
  getProvenanceLabel,
  getTaskTypeLabel,
  inFlightTasks,
  pickLearningTask,
  queuedTaskIds,
  secondaryTasks,
  searchSpendLine,
  SPEND_LEDGER_NOTE,
  spendShareLine,
  weeklyMetricRows,
} from "@/lib/presentation/today-view";
import {
  Badge,
  Card,
  CardHeader,
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
import { GoalStatusActions } from "./goal-status-actions";

export const metadata: Metadata = {
  title: "Today · Cabinet",
};

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const data = await fetchTodayPage();
  const tz = data.user.timezone;
  /*
    目标列表按创建顺序来，第一个不一定是"还在推进"的那个：暂停/完成/归档的目标
    也会留在列表里（用户得能找回它们）。所以主目标只认 status === "active"，
    一个都没有时宁可让页头说"没有进行中的目标"，也不让一个停掉的目标冒充当前方向。
  */
  const activeGoals = data.goals.filter((goal) => goal.status === "active");
  const inactiveGoals = data.goals.filter((goal) => goal.status !== "active");
  const primaryGoal = activeGoals[0];
  /*
    Who spent the week's model budget. It comes from the same ledger rows as
    `weekly.costCents`, so the card's big number and its "top spender" line
    can never quote two different sources.
  */
  const topSpender = data.topSpender;
  /*
    消耗卡底部那行字数的是「还能接单的人」，不是花名册人数：已退休的、
    还在学徒期的 Agent 一次任务都跑不了（policy.ts:323-329），它们不会再往
    这本账里加钱。判据与 QuickCreate 的下拉、createTask 的守卫同一份。
  */
  const ableAgents = data.agents.filter(
    (agent) => assigneeBlockReason(agent) === null,
  ).length;
  /*
    `data.tasks` is every open task, failed and awaiting_approval included.
    Those are waiting on the reader, not progressing, so the counters and the
    check-in candidates use the in-flight subset instead.
  */
  const inFlight = inFlightTasks(data.tasks);
  /*
    The stored brief was written from the counts at generation time, so the
    badge under it must quote that snapshot instead of today's queue — it used
    to print the live count and thereby rewrote the brief's own provenance as
    tasks moved. A row without the metric yields null and the badge then states
    only what it knows. The fallback text below is assembled right now, so for
    that one the current count *is* the snapshot.
  */
  // 这张卡取的是最近一份每日早报，不是「今天的」：早报按本地日期分份，跨天没重跑
  // 时卡里还是上一份的正文，标题却写着「今天的关键判断」。
  const briefState = briefFreshness({
    period: data.brief?.period ?? null,
    todayKey: localDateKey(new Date(), data.user.timezone),
  });
  // 「已写入记忆」不是这句话的默认答案：一条既没学习时长、也没回忆分 / 薄弱点 /
  // 备注的打卡不会生成记忆行（checkins.ts 里 if (memoryContent) 才插）。
  const yesterdayMemory = data.yesterdayCheckin
    ? checkinMemoryContent(data.yesterdayCheckin)
    : "";
  const briefTaskCount = data.brief
    ? briefTaskSnapshot(data.brief)
    : inFlight.length;
  const agentById = new Map(data.agents.map((a) => [a.id, a]));
  const today = new Intl.DateTimeFormat("zh-CN", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: tz,
  }).format(new Date());

  /*
    One ordered queue of everything blocked on the reader. It is built from the
    same `data` the rest of the page renders, so it cannot disagree with the
    lists below; it only decides what comes first.
  */
  const actionQueue = buildTodayActionQueue({
    timeZone: tz,
    approvals: data.approvals.map((approval) => ({
      id: approval.id,
      taskId: approval.taskId,
      action: approval.action,
      payload: approval.payload,
    })),
    council: data.council
      ? {
          id: data.council.id,
          topic: data.council.topic,
          trigger: data.council.trigger,
        }
      : null,
    tasks: data.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      dueAt: task.dueAt,
    })),
  });
  const inQueue = queuedTaskIds(actionQueue);
  /* Everything the queue already names is removed from the lists below, so a
     task is never shown twice with two different calls to action. */
  const remainingTasks = secondaryTasks(data.tasks, actionQueue);

  const learningTask = pickLearningTask(data.tasks, { excludeIds: inQueue });

  /*
    兜底早报与 `regenerateBrief` 写的正文共用同一组句子（src/lib/presentation/
    brief-view.ts）。以前这里手写了一版、服务端手写了一版，点「重新生成早报」后
    存下来的正文就和这屏对不上：暂停的目标仍被当成方向、非学习目标那个没人再算的
    百分比照印、失败任务被数成「待推进」。第三行（需要你决定）同样是共用函数：这里原来
    自己数了一遍审批、漏掉内阁会议，而服务端那版把两者都列了出来。
  */
  const brief =
    data.brief?.narrative ??
    `# 今日早报\n\n目标：${briefGoalLine(data.goals)}\n\n## 今天的关键判断\n- ${briefTaskLine(
      data.tasks,
    )}\n${briefDecisionLine({
      approvals: data.approvals.length,
      hasCouncil: Boolean(data.council),
    })}`;

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
                ? `目标：${primaryGoal.title} (${goalProgressText(
                    primaryGoal.domain,
                    primaryGoal.progress,
                  )})`
                : data.goals.length > 0
                  ? "没有进行中的目标"
                  : "尚未设定目标"}
            </span>
            <span>·</span>
            <span className="text-ink font-medium">
              {inFlight.length} 项任务推进中
            </span>
            {actionQueue.counts.total > 0 ? (
              <>
                <span>·</span>
                <span className="text-accent font-medium">
                  {actionQueue.counts.total} 项待处理
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
        Priority 1: everything blocked on the reader, in one ordered list.
        Always rendered, including when empty. A card that silently disappears
        leaves the reader unsure whether the queue is empty or the page failed
        to load it — the empty state says which.
      */}
      <Card
        variant={actionQueue.isEmpty ? "default" : "decision"}
        className="mb-6"
      >
        <CardHeader
          eyebrow="Action Queue"
          title="现在需要我处理"
          right={
            actionQueue.isEmpty ? (
              <Badge tone="neutral">当前没有待办</Badge>
            ) : (
              <Badge tone="accent">{actionQueue.counts.total} 项待处理</Badge>
            )
          }
        />
        {actionQueue.isEmpty ? (
          <div className="px-5 py-6">
            <EmptyState
              icon={<Inbox className="size-4" />}
              title={actionQueue.empty.title}
              hint={actionQueue.empty.hint}
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
            {actionQueue.items.map((item) => {
              const approval =
                item.kind === "approval"
                  ? data.approvals.find((a) => a.id === item.refId)
                  : undefined;
              const icon =
                item.kind === "council" ? (
                  <Gavel className="mt-0.5 size-4 shrink-0 text-violet" />
                ) : item.kind === "approval" ? (
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-accent" />
                ) : (
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
                );
              const body = (
                <div className="flex items-start gap-2.5 min-w-0 flex-1">
                  {icon}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="text-label font-semibold text-ink"
                        title={item.title}
                      >
                        {item.title}
                      </span>
                      {item.status ? <StatusBadge status={item.status} /> : null}
                    </div>
                    <div className="mt-1 text-label text-muted">{item.hint}</div>
                    {item.detail ? (
                      <div className="mt-0.5 text-label text-faint">
                        {item.detail}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
              // An approval is decided in place; the row itself is not a link,
              // because the decision buttons already sit in it.
              return approval ? (
                <div key={item.key} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    {body}
                    <ApprovalActions
                      approvalId={approval.id}
                      actionType={approval.action}
                    />
                  </div>
                </div>
              ) : (
                <Link
                  key={item.key}
                  href={item.href}
                  className="group flex items-center gap-3 px-5 py-4 transition-colors hover:bg-white/[0.02]"
                >
                  {body}
                  <div className="flex shrink-0 items-center gap-1.5 text-label font-medium text-muted transition-colors group-hover:text-ink">
                    <span>{item.kind === "council" ? "进入决策室" : "查看任务"}</span>
                    <ArrowRight className="size-3.5" />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </Card>

      {/*
        Priority 2: exactly one next action, or a clear way to create one.
        The learning task is picked with the action-queue ids excluded, so this
        card can never recommend a task the reader was just asked to unblock.
      */}
      <Card variant="elevated" className="mb-6 border-accent/30 bg-panel-raised/95">
        <CardHeader
          eyebrow="Next step"
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
                    <span
                      className="truncate text-emphasis font-semibold text-ink"
                      title={learningTask.title}
                    >
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
              {
                /*
                  A learning task awaiting approval is excluded from this card on
                  purpose (it is in the queue above), so "没有学习任务" would
                  contradict what the reader can see on the same screen.
                */
              }
              <div className="text-label font-medium text-ink">没有可以直接开始的学习任务</div>
              <p className="mt-1 max-w-md text-label text-muted">
                待处理队列里的学习任务要先处理；若队列里也没有，Coach 可以根据你的知识网络与记忆召回率，为你安排针对性巩固与新内容学习。
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
                <NextLearningTaskButton />
                <Link
                  href="/cabinet"
                  className="inline-flex items-center justify-center gap-1.5 rounded-md border border-line2 bg-panel2 px-3 py-1.5 text-label text-ink transition-colors hover:bg-panel-hover"
                >
                  让内阁规划新任务
                  <ArrowRight className="size-3" />
                </Link>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/*
        Priority 3: goal progress, before the background material. The reader
        needs to know whether the week is moving toward the goal before reading
        how many tokens it cost.
      */}
      <Card className="mb-6">
        <CardHeader
          eyebrow="Goals"
          title="目标进度"
          right={
            primaryGoal ? (
              <Badge tone={primaryGoal.domain === "learning" ? "accent" : "neutral"}>
                {goalProgressText(primaryGoal.domain, primaryGoal.progress)}
              </Badge>
            ) : data.goals.length > 0 ? (
              <Badge tone="neutral">没有进行中的目标</Badge>
            ) : (
              <Badge tone="neutral">尚未设定目标</Badge>
            )
          }
        />
        <div className="space-y-4 px-5 py-4">
          {data.goals.length > 0 ? (
            <>
              {activeGoals.length > 0 ? (
                activeGoals.map((goal) => (
                  <GoalRow key={goal.id} goal={goal} />
                ))
              ) : (
                <div className="text-label text-faint">
                  当前没有进行中的目标。下面仍是你的目标，可以恢复或重新打开。
                </div>
              )}
              {inactiveGoals.length > 0 ? (
                <div
                  className={
                    activeGoals.length > 0
                      ? "border-t border-line pt-3"
                      : undefined
                  }
                >
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className="text-eyebrow uppercase tracking-[0.14em] text-faint">
                      paused · completed · archived
                    </span>
                    <span className="text-label text-faint">
                      {inactiveGoals.length} 个不在推进中，仍可在这里恢复或重新打开
                    </span>
                  </div>
                  <div className="space-y-3">
                    {inactiveGoals.map((goal) => (
                      <GoalRow key={goal.id} goal={goal} muted />
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-label text-faint">
              还没有设定目标。有了目标，内阁才知道该替你推进什么。
            </div>
          )}
        </div>
      </Card>

      {/*
        The secondary task list. Tasks already named in the action queue are
        removed from it entirely — not greyed out, not repeated with a different
        button — so one task never appears twice with two different calls to
        action. The header states where they went.
      */}
      <Card className="mb-8">
        <CardHeader
          eyebrow="Today"
          title="其他推进中的任务"
          right={
            <div className="flex items-center gap-3">
              <Badge tone="neutral">{remainingTasks.length} 项进行中</Badge>
              {actionQueue.counts.task > 0 ? (
                <span className="text-label text-faint">
                  {actionQueue.counts.task} 项待处理见上
                </span>
              ) : null}
              <Link
                href="/cabinet"
                className="flex items-center gap-1 text-label text-muted transition-colors hover:text-ink"
              >
                内阁分工 <ArrowRight className="size-3" />
              </Link>
            </div>
          }
        />
        {remainingTasks.length > 0 ? (
          <div className="divide-y divide-line">
            {remainingTasks.map((task) => {
              const agent = task.assigneeId ? agentById.get(task.assigneeId) : null;
              const typeLabel = getTaskTypeLabel(task);
              const provenanceLabel = getProvenanceLabel(task.createdBy);

              return (
                <Link
                  key={task.id}
                  href={`/tasks/${task.id}`}
                  className="group flex items-center gap-3.5 px-5 py-3.5 transition-colors hover:bg-white/[0.02]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="truncate text-label font-medium text-ink group-hover:text-accent transition-colors"
                        title={task.title}
                      >
                        {task.title}
                      </span>
                      <span className="rounded border border-line bg-panel2/60 px-1.5 py-0.5 text-eyebrow text-faint">
                        {provenanceLabel}
                      </span>
                      <span className="rounded border border-line bg-panel2/60 px-1.5 py-0.5 text-eyebrow text-muted">
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
              icon={<Sparkles className="size-4" />}
              title={
                actionQueue.counts.task > 0
                  ? "其余任务都在正常推进"
                  : "今天暂无待推进任务"
              }
              hint={
                actionQueue.counts.task > 0
                  ? "需要你介入的任务都排在上方；这里只列出 Agent 正在自行推进的部分。"
                  : "内阁成员目前都在就绪状态。你可以让 Coach 规划学习任务，或在下方快速创建新任务。"
              }
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
            {/* 模型推理与工具预留：这本账是 agent_budget_periods，不是纯
                token 账单（见 SPEND_LEDGER_NOTE）。 */}
            <div className="p-5">
              <div className="flex items-center justify-between">
                <div className="text-label font-medium uppercase tracking-[0.14em] text-faint">
                  模型推理与工具预留 (Budget Ledger)
                </div>
                <Badge tone={weekly.costCents > 0 ? "accent" : "neutral"}>
                  预算台账口径
                </Badge>
              </div>
              <div className="mt-2 text-page font-semibold tracking-tight text-ink tabular-nums font-mono">
                {weekly.costCents > 0 ? money(weekly.costCents) : "¥0.00"}
              </div>
              {/*
                No fallback sentence when nobody spent: the figure above already
                reads ¥0.00, and a second line about spending nothing is noise.
                Naming the spender now uses the ledger's cents, the same rows
                that produce the total above.
              */}
              {topSpender ? (
                <p className="mt-1.5 text-label text-muted">
                  主要消耗者：{topSpender.name}（{money(topSpender.cents)}）
                </p>
              ) : null}
              <div className="mt-2 text-label text-faint">
                {spendShareLine({ total: data.agents.length, able: ableAgents })}
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
                {/* 单价 0 有两种来源：没定价（按次计费）和不收费（抓页面）。 */}
                {searchSpendLine(weekly.search)}
              </p>
            </div>
          </div>
          {/* 两列的钱不是同一个口径，说明写在一处，避免各列自己编一句话。 */}
          <p className="border-t border-line/70 px-5 py-3 text-label leading-relaxed text-faint">
            {SPEND_LEDGER_NOTE}
          </p>
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
              eyebrow="Morning Brief"
              title="今天的关键判断"
              right={<BriefButton />}
            />
            <div className="px-5 py-4">
              {briefState.stale ? (
                <p className="mb-3 rounded-md border border-line bg-panel2 px-3 py-2 text-label leading-relaxed text-muted">
                  {briefState.note}
                </p>
              ) : null}
              <Markdown content={brief} />
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
              {/*
                Provenance, stated plainly: this brief is assembled by
                `regenerateBrief` from counts in the read model. Nothing here
                asks a model, so the card must not imply one wrote it.
              */}
              <Badge
                tone="neutral"
                title="由 regenerateBrief 按任务数、审批数和目标进度套模板生成，没有调用模型"
              >
                <FileCode2 className="size-2.5" /> 由规则脚本生成
              </Badge>
              <Badge
                tone="teal"
                title="数字取自生成早报那一刻的读模型；之后任务有变动，正文与这里都不会改写，重新生成才会更新"
              >
                <ShieldCheck className="size-2.5" />{" "}
                {briefTaskCount === null
                  ? "基于生成时的任务快照"
                  : `基于生成时的 ${briefTaskCount} 个待推进任务`}
              </Badge>
              <Badge tone="accent">
                <Sparkles className="size-2.5" /> {data.counts.proposedInsights} 条洞察待采纳
              </Badge>
              {briefState.stale ? (
                <Badge tone="accent">{briefState.label}</Badge>
              ) : null}
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
                    tasks={inFlight.map((t) => ({
                      id: t.id,
                      title: t.title,
                      // 状态决定勾上之后任务会不会真的变成完成（checkin-view.ts）。
                      status: t.status,
                    }))}
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
                      <span aria-hidden="true" className="text-faint">·</span>
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
                    {yesterdayMemory ? (
                      <Badge tone="teal">
                        <CheckCircle2 className="size-2.5" /> 已写入记忆
                      </Badge>
                    ) : (
                      <Badge
                        tone="neutral"
                        title="这条 check-in 没有学习时长、回忆正确率、薄弱点和备注，按写入规则不会生成记忆行"
                      >
                        没有内容可写入记忆
                      </Badge>
                    )}
                  </div>
                ) : (
                  <div className="text-label text-faint">还没有昨天的 check-in。</div>
                )}
              </div>
            </Card>
          </div>
        </div>

        {/* Agent 动态与快速创建（目标进度已上移到优先级 3，此处不再重复） */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.2fr_1fr]">
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
                {/* 表单要自己判断谁能接单（退休的、未转正的不能），所以状态也得传下去。 */}
                <QuickCreate
                  agents={data.agents.map((agent) => ({
                    id: agent.id,
                    name: agent.name,
                    role: agent.role,
                    status: agent.status,
                    lifecycleStage: agent.lifecycleStage,
                  }))}
                  goals={data.goals
                    // 已归档的目标不再接受新任务（归档是"这段结束了"），完成的目标
                    // 仍可补做，但在下拉里标出来，免得被当成还在推进的方向。
                    .filter((goal) => goal.status !== "archived")
                    .map((goal) => ({
                      id: goal.id,
                      title:
                        goal.status === "completed"
                          ? `${goal.title}（已完成）`
                          : goal.title,
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

/**
 * 一行目标：标题 + 状态 + 进度 + 目标说明 + 生命周期按钮。
 *
 * 状态用目标自己的词（进行中 / 已暂停 / 已完成 / 已归档）而不是 StatusBadge：
 * 后者说的是 Agent "在岗 / 暂停"，套到目标上会把暂停读成"这个人被停职了"。
 * 非进行中的目标是弱化而不是隐藏——归档不等于删除，用户要能把它找回来重开。
 */
function GoalRow({ goal, muted = false }: { goal: GoalDto; muted?: boolean }) {
  const isActive = goal.status === "active";
  return (
    <div className={cn(muted && "opacity-75")}>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-label text-ink" title={goal.title}>
            {goal.title}
          </span>
          <Badge tone={isActive ? "teal" : "neutral"}>
            {goalStatusLabel(goal.status)}
          </Badge>
        </span>
        <span className="mono text-label text-muted">
          {goalProgressText(goal.domain, goal.progress)}
        </span>
      </div>
      {goal.domain === "learning" ? (
        <Progress
          label={`${goal.title} 的目标进度`}
          value={goal.progress}
          tone="accent"
        />
      ) : (
        <div className="text-label text-faint">{goalProgressHint(goal.domain)}</div>
      )}
      <div className="mt-1 text-label text-faint">{goal.target}</div>
      <GoalStatusActions
        goalId={goal.id}
        status={goal.status}
        title={goal.title}
      />
    </div>
  );
}
