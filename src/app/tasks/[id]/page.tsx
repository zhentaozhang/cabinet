import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  TriangleAlert,
  Clock3,
  ExternalLink,
  FileText,
  FolderOpen,
  Link2,
  Play,
  Search,
  ShieldCheck,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react";
import { fetchTaskPage } from "@/lib/api/pages";
import {
  actionTypeLabel,
  resourceLabel,
  riskLabel,
  roleMeta,
  statusLabel,
  statusTone,
} from "@/lib/agents";
import { dateTime, money, timeOnly } from "@/lib/format";
import { goalStatusLabel } from "@/contracts/labels";
import { isSimulatedSource, sourceLabel } from "@/lib/domain/provenance";
import {
  STEP_META,
  TOOL_STATUS_MAP,
  classifyEvidence,
  getChecklistRuleLabel,
  getChecklistTypeTag,
  getCitationRelationship,
  getCurrentAttempt,
  getStatusBannerInfo,
  getNextActionCopy,
  getStatusSummary,
  pendingDecisionItems,
  resolveFailurePresentation,
  summarizeTaskCitations,
} from "@/lib/presentation/task-view";
import {
  Avatar,
  Badge,
  Card,
  CardHeader,
  EmptyState,
} from "@/components/ui";
import { parseClaimsTable } from "@/lib/domain/claims";
import {
  ApprovalActions,
  ArtifactSubmitForm,
  TaskActions,
} from "@/components/actions";
import { Markdown } from "@/components/markdown";
import { TaskDecisionCard } from "./decision-card";
import { PolicyPreviewPanel } from "./policy-preview-panel";
import { VerifiabilityPanel } from "./verifiability-panel";

export const metadata: Metadata = {
  title: "Task · Cabinet",
};

export const dynamic = "force-dynamic";


export default async function TaskPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await fetchTaskPage(id);
  if (!data) notFound();
  const tz = data.timezone;
  const { task, goal, assignee, auditor, runs, steps, artifacts, evidence, approvals, audit, override, actions } = data;

  const stepsByRun = new Map<string, typeof steps>();
  for (const step of steps) {
    const list = stepsByRun.get(step.runId) ?? [];
    list.push(step);
    stepsByRun.set(step.runId, list);
  }

  // The banner, the failure panel and the evidence note describe the task *now*,
  // so they read only the newest attempt. History stays in the run timeline.
  const { failedRun, toolStep, toolReason, failureReason } = getCurrentAttempt(
    runs,
    steps,
  );

  // Audits & rejections
  const latestAudit = audit.find((a) => a.action.startsWith("audit."));
  const latestAuditReject = audit.find((a) => a.action === "audit.reject");
  const isRejected = task.status === "rejected" || latestAudit?.action === "audit.reject";
  const rejectionReason =
    ((latestAuditReject?.after ?? latestAudit?.after) as Record<string, unknown> | null)?.reason as string | undefined;

  function runProvenance(run: (typeof runs)[number]): {
    label: string;
    tone: "teal" | "accent" | "neutral" | "danger";
  } {
    if (run.mode === "live" && run.providerAttemptId) {
      return { label: "真实模型", tone: "teal" };
    }
    if (run.mode === "live") return { label: "未连上模型", tone: "danger" };
    if (run.mode === "demo") return { label: "演示模板", tone: "accent" };
    return { label: "规则产出", tone: "neutral" };
  }

  // Checklist computation: prioritize failures and undetermined items first
  const checklistRows = (task.acceptanceChecklist ?? []).map((item, index) => ({
    item,
    index,
    result: task.acceptanceReport?.[index] ?? null,
  }));
  const failedRows = checklistRows.filter((row) => row.result && !row.result.passed);
  const undeterminedRows = checklistRows.filter((row) => row.result?.undetermined);
  const passedRows = checklistRows.filter(
    (row) => row.result && row.result.passed && !row.result.undetermined
  );
  const pendingRows = checklistRows.filter((row) => !row.result);

  const orderedChecklist = [
    ...failedRows,
    ...undeterminedRows,
    ...passedRows,
    ...pendingRows,
  ];
  const passedCount = passedRows.length;
  const failedCount = failedRows.length;
  const undeterminedCount = undeterminedRows.length;
  const totalChecklistCount = checklistRows.length;
  const allPassed =
    totalChecklistCount > 0 && passedCount === totalChecklistCount;
  /*
    审计没有给出结论时，光有横幅上的"待你判定"是不够的：用户还得自己往
    下翻清单、猜哪一条没人判。这里把"必须判却没有判定人"的条目先摘出来，
    卡片列的就是他要点"通过/驳回"所依据的那几条。
  */
  const pendingDecisions =
    task.status === "needs_review"
      ? pendingDecisionItems(task.acceptanceReport)
      : [];

  // One failure verdict for the whole page. The banner and the reason panel
  // used to test different conditions, so a run that failed while recovery
  // rewound the task row to `planned` got a banner promising "the reason is
  // below" and no panel below it.
  const failure = resolveFailurePresentation({
    taskStatus: task.status,
    hasFailedRun: Boolean(failedRun),
    failureReason,
    isRejected,
  });
  const bannerInfo = getStatusBannerInfo(
    task.status,
    approvals.some((a) => a.status === "pending"),
    failure.showBanner,
    isRejected,
    toolStep
  );
  // The banner states the state and the move it implies. The category is the
  // contract between the two: a status that asks the reader to act must not
  // describe itself as "waiting", and vice versa.
  const statusSummary = getStatusSummary(task.status);
  // Derived from the banner, not the raw status: the banner already folds in
  // a failed run and a pending approval, so the next-action line cannot tell
  // the reader to "wait" under a banner that says the run failed.
  const nextAction = getNextActionCopy(bannerInfo.nextActionCategory);

  // Citation ↔ evidence relationship, computed once and shared by the
  // deliverable and evidence cards so the two cannot disagree.
  const citationSummary = summarizeTaskCitations(
    artifacts,
    evidence.map((item) => item.id)
  );

  // The model's own claim→source map. We show it exactly as written and only
  // flag citations that do not resolve; whether a quote supports a sentence is
  // a judgement we deliberately do not fake.
  const claimsRows = artifacts.flatMap((artifact) =>
    parseClaimsTable(artifact.content).rows.map((row) => ({
      claim: row.claim,
      refs: row.refs,
      supported: row.supported,
      dangling: row.refs.filter((ref) => !evidence.some((item) => item.id === ref)),
    }))
  );

  return (
    <div className="space-y-6">
      {/* Top back navigation and task identity */}
      <div>
        <Link
          href="/"
          className="mb-3 inline-flex items-center gap-1.5 text-label text-faint hover:text-muted transition-colors"
        >
          <ArrowLeft className="size-3" /> 返回今日工作台
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          {goal ? (
            <Badge tone="neutral" className="text-muted">
              目标 · {goal.title}
            </Badge>
          ) : null}
          <span className="mono text-label text-faint">{task.id}</span>
          <span className="text-label text-faint">·</span>
          <span className="text-label text-faint">
            优先级 P{task.priority}
          </span>
          {task.riskLevel ? (
            <span className="text-label text-faint">
              · 风险等级 {riskLabel(task.riskLevel)}
            </span>
          ) : null}
        </div>

        <h1 className="mt-1.5 text-page font-semibold tracking-tight text-ink">
          {task.title}
        </h1>
        {task.description ? (
          <p className="mt-1.5 max-w-3xl text-label leading-relaxed text-muted">
            {task.description}
          </p>
        ) : null}
      </div>

      {/* Requirement 1: Prominent Top Status & Action Banner */}
      <div
        className={`rounded-xl border ${bannerInfo.bannerBorderClass} ${bannerInfo.bannerBgClass} p-5 shadow-sm`}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <Badge tone={bannerInfo.badgeTone} className="font-semibold px-2.5 py-0.5">
                {bannerInfo.badgeLabel}
              </Badge>
              <span className="text-label font-semibold text-ink">
                {bannerInfo.title}
              </span>
            </div>
            <p className="mt-1.5 text-label leading-relaxed text-muted">
              {bannerInfo.description}
            </p>
            {/* The state must say what it wants from the reader. The category
                comes from the same mapping the banner uses, so the two can
                never drift into "waiting" copy for a state that needs action. */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-label">
              <span className="inline-flex items-center gap-1 rounded border border-line2 bg-panel2/60 px-2 py-0.5 font-medium text-ink-soft">
                <Activity className="size-3 shrink-0" />
                下一步：{nextAction.label}
              </span>
              <span className="text-faint">{nextAction.hint}</span>
            </div>
            {!statusSummary.known ? (
              <p className="mt-2 text-label leading-relaxed text-danger">
                状态值「{statusSummary.status}」不在已知范围内，本页不会把它当作已完成或已通过处理。
              </p>
            ) : null}
          </div>

          {/*
            `shrink-0` here kept the action row at its min-content width, which
            overflowed the card on a 320px screen where the buttons cannot fit
            side by side. Taking the full row width below `sm` lets
            TaskActions' own `flex-wrap` do its job.
          */}
          <div className="w-full min-w-0 sm:w-auto sm:shrink-0">
            <TaskActions taskId={task.id} status={task.status} actions={actions} />
          </div>
        </div>

        {/* Hoisted alert reason if rejected: user never has to scroll through long logs */}
        {isRejected ? (
          <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-3.5">
            <div className="flex items-start gap-2.5">
              <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-label font-semibold text-danger">
                    Auditor 驳回原因
                  </span>
                  {latestAudit ? (
                    <span className="text-label text-faint">
                      · 判定于 {dateTime(latestAudit.createdAt, tz)}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-label leading-relaxed text-ink-soft">
                  {rejectionReason || "产物未能完全达标，请对照下方未通过的验收标准调整交付内容。"}
                </div>
                {failedRows.length > 0 ? (
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-eyebrow font-medium uppercase tracking-wider text-danger">
                      不达标项：
                    </span>
                    {failedRows.map(({ item, index, result }) => (
                      <span
                        key={index}
                        className="inline-flex items-center gap-1 rounded border border-danger/30 bg-danger/10 px-2 py-0.5 text-label text-danger"
                      >
                        <XCircle className="size-3 shrink-0" />
                        <span>{getChecklistRuleLabel(item)}</span>
                        {/* No extra opacity here: stacking 0.8 on the danger
                            tone dropped this to 4.3:1, under the reading floor. */}
                        {result?.reason ? (
                          <span className="text-danger/90">（{result.reason}）</span>
                        ) : null}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {/* Hoisted alert reason if failed */}
        {failure.showPanel ? (
          <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-3.5">
            <div className="flex items-start gap-2.5">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
              <div className="min-w-0 flex-1">
                <div className="text-label font-semibold text-danger">
                  {failure.title}
                </div>
                <div className="mt-1 text-label leading-relaxed text-ink-soft font-mono break-words">
                  {failureReason}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {/* Hoisted alert if pending approval */}
        {task.status === "awaiting_approval" && approvals.length > 0 ? (
          <div className="mt-4 rounded-lg border border-accent/30 bg-accent/10 p-3.5">
            <div className="flex items-start gap-2.5">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="text-label font-semibold text-accent">
                  待审批动作：{approvals[0].action}
                </div>
                <div className="mt-1 text-label leading-relaxed text-ink-soft">
                  {String(approvals[0].payload.reason ?? approvals[0].payload.note ?? "请在右侧审批卡片中确认放行")}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Artifact submission form for user answers */}
      <ArtifactSubmitForm
        taskId={task.id}
        status={task.status}
        actionType={task.actionType}
      />

      {/* Main Execution Workspace Grid */}
      <div className="grid gap-6 lg:grid-cols-[1.85fr_1fr]">
        <div className="space-y-6">
          {/* ① 执行过程：运行时间线与工具调用 */}
          <Card>
            <CardHeader
              eyebrow="Run Trace & Execution"
              title="运行过程与工具调用"
              right={
                <span className="text-label text-faint">
                  共 {runs.length} 次运行
                </span>
              }
            />
            {runs.length === 0 ? (
              <div className="px-5 py-8">
                <EmptyState
                  icon={<Activity className="size-4" />}
                  title="还没有运行记录"
                  hint="点击上方「执行」按钮，让 Agent 产出第一版执行轨迹。"
                />
              </div>
            ) : (
              <div className="divide-y divide-line">
                {[...runs].reverse().map((run, runIndex) => {
                  const runSteps = stepsByRun.get(run.id) ?? [];
                  const prov = runProvenance(run);

                  return (
                    <div key={run.id} className="px-5 py-4">
                      {/* Run summary banner */}
                      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel2/50 px-3.5 py-2.5">
                        <span
                          className={`size-2 rounded-full ${
                            run.status === "succeeded"
                              ? "bg-teal shadow-[0_0_8px_rgba(59,185,158,0.5)]"
                              : run.status === "failed"
                                ? "bg-danger shadow-[0_0_8px_rgba(239,98,98,0.5)]"
                                : "bg-blue shadow-[0_0_8px_rgba(91,159,248,0.5)]"
                          }`}
                        />
                        <span className="mono text-label font-medium text-ink">
                          Run #{runs.length - runIndex}
                        </span>
                        <span className="mono text-label text-faint">({run.id})</span>
                        {/* The dot above is decorative; the outcome must be
                            readable as text, never by colour alone. */}
                        <Badge tone={statusTone(run.status)}>
                          {statusLabel(run.status)}
                        </Badge>
                        <Badge tone={run.agentId === auditor?.id ? "danger" : "neutral"}>
                          {run.agentId}
                        </Badge>
                        <Badge tone={prov.tone}>{prov.label}</Badge>
                        {run.model ? (
                          <span className="mono text-label text-faint">
                            {run.provider ? `${run.provider}/` : ""}{run.model}
                          </span>
                        ) : null}
                        <span className="text-label text-faint">
                          · {run.tokensIn === null || run.tokensOut === null
                            ? "用量未知"
                            : `${run.tokensIn + run.tokensOut} tokens`}{" "}
                          · {money(run.costCents)}
                        </span>
                        <span className="ml-auto text-label text-faint">
                          {timeOnly(run.startedAt, tz)} → {timeOnly(run.endedAt, tz)}
                        </span>
                      </div>

                      {/* Run error if failed */}
                      {run.error ? (
                        <div className="mt-2.5 rounded-lg border border-danger/30 bg-danger/10 px-3.5 py-2 text-label text-danger">
                          <span className="font-medium">运行失败报错：</span>
                          <span className="font-mono break-words">{run.error}</span>
                        </div>
                      ) : null}

                      {/* Steps timeline */}
                      <div className="mt-4 space-y-0 pl-1">
                        {runSteps.map((step, sIdx) => {
                          const meta = STEP_META[step.type] ?? {
                            label: step.type,
                            description: "执行过程步骤",
                            icon: Terminal,
                            toneClass: "text-muted",
                            bgClass: "bg-panel2",
                            borderClass: "border-line",
                          };

                          const stepToolStatus =
                            typeof step.output?.status === "string" ? step.output.status : null;
                          const toolStatusConfig = stepToolStatus ? TOOL_STATUS_MAP[stepToolStatus] : null;

                          return (
                            <div key={step.id} className="relative flex gap-3 pb-3.5">
                              {sIdx < runSteps.length - 1 ? (
                                <span className="absolute left-[9px] top-4 h-full w-px bg-line" />
                              ) : null}

                              {/* Step index badge */}
                              <span
                                className={`relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-eyebrow font-medium ${meta.borderClass} ${meta.bgClass} ${meta.toneClass}`}
                              >
                                {step.idx}
                              </span>

                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className={`text-label font-medium ${meta.toneClass}`}>
                                    {meta.label}
                                  </span>

                                  {step.tool ? (
                                    <span className="mono inline-flex items-center gap-1 rounded border border-line bg-panel2 px-1.5 py-0.5 text-label text-violet">
                                      <Wrench className="size-2.5" />
                                      {step.tool}
                                    </span>
                                  ) : null}

                                  {stepToolStatus ? (
                                    <Badge
                                      tone={
                                        toolStatusConfig?.tone ??
                                        (stepToolStatus === "ok" ? "teal" : "danger")
                                      }
                                      title={toolStatusConfig?.description}
                                    >
                                      {toolStatusConfig?.label ?? stepToolStatus}
                                    </Badge>
                                  ) : null}

                                  <span className="text-label text-faint">
                                    {step.latencyMs}ms · {step.tokensIn + step.tokensOut} tok
                                  </span>
                                </div>

                                {/* Collapsible details for inputs/outputs */}
                                <details className="group mt-1.5">
                                  <summary className="flex items-center gap-1.5 cursor-pointer text-label text-faint hover:text-muted select-none">
                                    <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
                                    <span>查看输入 / 输出参数</span>
                                  </summary>
                                  {/*
                                    `min-w-0` on both columns is what lets the
                                    `pre` scroll: a grid item defaults to
                                    `min-width: auto`, so without it the widest
                                    JSON line sets the track width and
                                    `overflow-x-auto` never engages.
                                  */}
                                  <div className="mt-2 grid gap-2.5 sm:grid-cols-2">
                                    <div className="min-w-0">
                                      <div className="mb-1 text-eyebrow font-medium uppercase text-faint">
                                        输入 Input
                                      </div>
                                      <pre className="max-h-56 overflow-x-auto rounded-lg border border-line bg-sunken p-2.5 text-label leading-relaxed text-muted font-mono">
                                        {JSON.stringify(step.input, null, 2)}
                                      </pre>
                                    </div>
                                    <div className="min-w-0">
                                      <div className="mb-1 text-eyebrow font-medium uppercase text-faint">
                                        输出 Output
                                      </div>
                                      <pre className="max-h-56 overflow-x-auto rounded-lg border border-line bg-sunken p-2.5 text-label leading-relaxed text-teal/80 font-mono">
                                        {JSON.stringify(step.output, null, 2)}
                                      </pre>
                                    </div>
                                  </div>
                                </details>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Attempt identifier. It locates this run's step rows
                          later; it is not a replay handle. */}
                      {run.runLabel ? (
                        <div className="mt-3 flex items-center gap-1.5 border-t border-line/60 pt-2.5 text-label text-faint">
                          <Play className="size-3 text-muted" />
                          <span>运行标识 runLabel:</span>
                          <span className="mono text-ink select-all break-all" title={run.runLabel}>
                            {run.runLabel}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* ② 交付产物：内容与来源模式 */}
          <Card>
            <CardHeader
              eyebrow="Deliverables"
              title="交付产物"
              right={
                artifacts.length > 0 ? (
                  <Badge tone="teal">{artifacts.length} 份产物</Badge>
                ) : (
                  <Badge tone="neutral">暂无产物</Badge>
                )
              }
            />
            {artifacts.length === 0 ? (
              <div className="px-5 py-8">
                <EmptyState
                  icon={<FolderOpen className="size-4" />}
                  title="暂无交付产物"
                  hint="点击上方「执行」让 Agent 生成第一版产物，或在上方「提交我的答案」中直接撰写。"
                />
              </div>
            ) : (
              <div className="divide-y divide-line">
                {artifacts.map((artifact, idx) => {
                  const artifactRelation = getCitationRelationship(
                    artifact.content,
                    evidence.map((item) => item.id)
                  );
                  const artifactCited = artifactRelation.cited;
                  const artifactDangling = artifactRelation.unresolved;
                  const artifactUncited = artifactRelation.uncited;

                  return (
                  <div key={artifact.id} className="px-5 py-4">
                    <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <FileText className="size-4 text-teal shrink-0" />
                        <span className="text-label font-semibold text-ink">
                          {artifact.title || `交付产物 #${artifacts.length - idx}`}
                        </span>
                        <Badge tone={artifact.submittedBy === "user" ? "accent" : "neutral"}>
                          {artifact.submittedBy === "user" ? "用户提交" : sourceLabel(artifact.sourceType)}
                        </Badge>
                        {isSimulatedSource(artifact.sourceType) ? (
                          <Badge tone="neutral" title="该产物来自显式演示或规则路径，不是真实模型调用">
                            非真实执行
                          </Badge>
                        ) : null}
                        {artifactCited.length > 0 ? (
                          <Badge
                            tone="teal"
                            title={`正文引用标记可在下方证据卡中找到：${artifactCited.join("、")}`}
                          >
                            <Link2 className="size-2.5" /> 引用 {artifactCited.length} 条证据
                          </Badge>
                        ) : null}
                        {artifactDangling.length > 0 ? (
                          <Badge
                            tone="danger"
                            title={`以下引用标记找不到对应证据行：${artifactDangling.join("、")}`}
                          >
                            <TriangleAlert className="size-2.5" /> {artifactDangling.length} 条引用失效
                          </Badge>
                        ) : null}
                        {artifactCited.length === 0 && artifactDangling.length === 0 ? (
                          <Badge
                            tone="neutral"
                            title="这份产物的正文没有 [cite:…] 标记，无法看出哪句结论对应哪条证据"
                          >
                            未标注引用
                          </Badge>
                        ) : null}
                        {artifactUncited.length > 0 && artifactCited.length > 0 ? (
                          <Badge
                            tone="neutral"
                            title={`还有这些证据未被这份产物引用：${artifactUncited.join("、")}`}
                          >
                            {artifactUncited.length} 条证据未被引用
                          </Badge>
                        ) : null}
                      </div>
                      <span className="text-label text-faint">{dateTime(artifact.createdAt, tz)}</span>
                    </div>

                    {artifactDangling.length > 0 ? (
                      <div className="mb-2.5 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-label text-danger">
                        产物正文引用了 {artifactDangling.length} 个不存在的证据 ID（
                        <span className="mono">{artifactDangling.join("、")}</span>
                        ），可能是模型编造或证据已被清理，请人工核实后再验收。
                      </div>
                    ) : null}

                    <details open={idx === 0} className="group">
                      <summary className="flex items-center gap-1.5 cursor-pointer text-label text-faint hover:text-muted select-none">
                        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
                        <span>{idx === 0 ? "收起产物正文" : "展开产物正文"}</span>
                      </summary>
                      <div className="mt-2.5 rounded-lg border border-line bg-sunken px-4 py-3.5 text-ink leading-relaxed">
                        <Markdown content={artifact.content} />
                      </div>
                    </details>
                  </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* ③ 证据与引用关系：检索来源与引用状态 */}
          <Card>
            <CardHeader
              eyebrow="Grounding & Evidence"
              title="检索证据与外部来源"
              right={
                evidence.length > 0 ? (
                  <div className="flex items-center gap-1.5">
                    {artifacts.length === 0 ? (
                      <Badge tone="neutral">暂无产物可引用</Badge>
                    ) : citationSummary.cited.length > 0 ? (
                      <Badge
                        tone="teal"
                        title="产物正文中的 [cite:…] 标记能在下方证据卡里找到；这只说明指向存在，不说明结论已被证据支撑"
                      >
                        被产物引用 {citationSummary.cited.length}/{evidence.length}
                      </Badge>
                    ) : (
                      <Badge
                        tone="accent"
                        title="证据已落库，但没有任何产物正文引用它——结论未与来源绑定"
                      >
                        产物未引用任何来源
                      </Badge>
                    )}
                    <Badge tone="neutral">共 {evidence.length} 条</Badge>
                  </div>
                ) : (
                  <Badge tone="neutral">无检索证据</Badge>
                )
              }
            />
            {/* States what the citation relation does and does not prove —
                a citation means "points at", never "supports". */}
            <div className="border-b border-line bg-panel2/40 px-5 py-2.5 text-label leading-relaxed text-muted">
              {citationSummary.groundingNote}
            </div>
            {citationSummary.unresolved.length > 0 ? (
              <div className="border-b border-danger/25 bg-danger/10 px-5 py-3 text-label text-danger">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <TriangleAlert className="size-3.5" />
                  产物引用了 {citationSummary.unresolved.length} 个本条任务不存在的证据 ID
                </span>
                <span className="ml-1.5 mono text-danger/80 break-all">
                  {citationSummary.unresolved.join("、")}
                </span>
                <p className="mt-1 text-danger/80">
                  这些引用不会被下方的证据卡接住，可能是模型编造，验收前请人工核实。
                </p>
              </div>
            ) : null}
            {evidence.length === 0 ? (
              <div className="px-5 py-6 text-center">
                <div className="mx-auto mb-2 flex size-9 items-center justify-center rounded-full border border-line bg-panel2 text-faint">
                  <Search className="size-4" />
                </div>
                <div className="text-label font-medium text-ink">这次运行没有落库外部证据</div>
                <p className="mt-1 text-label text-muted max-w-md mx-auto">
                  {toolReason}
                </p>
                <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-line bg-panel2/60 px-3 py-1 text-label text-faint">
                  <ShieldCheck className="size-3 text-teal" />
                  Cabinet 遵循证据落库原则：未调用真实网络检索时不产生虚假引用条目。
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {evidence.map((item) => {
                  const provenance = classifyEvidence(item);
                  const IconComponent = provenance.icon;
                  const hasExternalLink = Boolean(item.url && item.url.startsWith("http"));
                  const isCited = citationSummary.cited.includes(item.id);

                  return (
                    <li key={item.id} className="px-5 py-4">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-line bg-panel2">
                          <IconComponent className="size-3.5 text-teal" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              {hasExternalLink ? (
                                <a
                                  href={item.url}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  title={item.title}
                                  className="group inline-flex items-center gap-1 text-label font-medium text-ink hover:text-accent truncate underline decoration-line2 underline-offset-2"
                                >
                                  <span className="truncate">{item.title}</span>
                                  <ExternalLink className="size-3 shrink-0 text-faint group-hover:text-accent" />
                                </a>
                              ) : (
                                <span className="text-label font-medium text-ink truncate" title={item.title}>
                                  {item.title}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {artifacts.length > 0 ? (
                                isCited ? (
                                  <Badge tone="teal" title="产物正文中出现了指向该条目的引用标记">
                                    <Link2 className="size-2.5" /> 已被引用
                                  </Badge>
                                ) : (
                                  <Badge tone="neutral" title="该来源已落库，但产物正文没有引用它">
                                    未被引用
                                  </Badge>
                                )
                              ) : null}
                              <Badge tone={provenance.tone}>{provenance.label}</Badge>
                              <span className="mono rounded border border-line bg-panel2 px-1.5 py-0.5 text-label text-violet font-medium">
                                [cite:{item.id}]
                              </span>
                            </div>
                          </div>

                          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-label text-faint">
                            {item.publisher ? (
                              <span className="truncate text-muted">{item.publisher}</span>
                            ) : null}
                            {item.publisher ? <span>·</span> : null}
                            <span className="mono">{item.provider}</span>
                            <span>·</span>
                            <span>检索于 {dateTime(item.retrievedAt, tz)}</span>
                          </div>

                          <div className="mt-2.5 rounded-md border-l-2 border-teal/40 bg-sunken/80 px-3.5 py-2 text-label leading-relaxed text-ink-soft italic">
                            <span aria-hidden="true">“</span>
                            {item.quote}
                            <span aria-hidden="true">”</span>
                          </div>

                          {hasExternalLink ? (
                            <div className="mt-2 text-label text-faint break-all mono">
                              <a
                                href={item.url}
                                target="_blank"
                                rel="noreferrer noopener"
                                title={item.url}
                                className="hover:text-muted hover:underline"
                              >
                                {item.url}
                              </a>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* 人拍板：审计说"没有结论"时，只有人能给出结论 */}
          {task.status === "needs_review" ? (
            <TaskDecisionCard taskId={task.id} items={pendingDecisions} />
          ) : null}

          {/*
            人拍板的结论写在 Auditor 的报告之前，而不是改写报告：下面的清单是
            "机器判了什么、哪几条它判不出"，这张卡是"最后是谁、凭什么拍板"。
            混写会让事后无法回答"这个任务当初到底有没有被自动判过"。
            放在验收卡片上方，是因为已 accepted 的任务若只在下方清单里留着
            几行"需人工复核"，页面读起来像还没人管。
          */}
          {override ? (
            <Card>
              <CardHeader
                eyebrow="Human Decision"
                title="你的判定"
                right={
                  <Badge tone={override.decision === "accepted" ? "teal" : "danger"}>
                    {override.decision === "accepted" ? (
                      <CheckCircle2 className="size-3" />
                    ) : (
                      <XCircle className="size-3" />
                    )}
                    {override.decision === "accepted" ? "你判定通过" : "你判定驳回"}
                  </Badge>
                }
              />
              <div className="px-5 py-4">
                <div className="mb-1 text-eyebrow font-medium uppercase tracking-wider text-faint">
                  判定理由
                </div>
                <p className="text-label leading-relaxed text-ink-soft">
                  {override.reason || "（这条判定没有留下理由）"}
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-faint">
                  <span>判定于 {dateTime(override.decidedAt, tz)}</span>
                  {override.artifactId ? (
                    <>
                      <span>·</span>
                      <span>
                        针对产物{" "}
                        <span className="mono text-muted">{override.artifactId}</span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span>·</span>
                      <span>没有对应产物</span>
                    </>
                  )}
                </div>
                <p className="mt-2.5 text-label leading-relaxed text-faint">
                  下面的清单仍是 Auditor 当时写下的结论，没有因为你这次判定被改写；
                  这次判定不计入 Agent 的信任分——它是你的判断，不是它自己跑出来的成绩。
                </p>
              </div>
            </Card>
          ) : null}

          {/* ④ 验收标准：契约规则与判定结果 */}
          <Card>
            <CardHeader
              eyebrow="Acceptance Contract"
              title="验收标准与规则契约"
              right={
                totalChecklistCount === 0 ? null : (
                  <div className="flex items-center gap-1.5">
                    {allPassed ? (
                      <Badge tone="teal">
                        <CheckCircle2 className="size-3" /> 全部通过 ({passedCount}/{totalChecklistCount})
                      </Badge>
                    ) : failedCount > 0 ? (
                      <Badge tone="danger">
                        <XCircle className="size-3" /> 未通过 ({failedCount}/{totalChecklistCount})
                      </Badge>
                    ) : undeterminedCount > 0 ? (
                      <Badge tone="accent">
                        <CircleAlert className="size-3" /> 需人工复核 ({undeterminedCount} 项)
                      </Badge>
                    ) : (
                      <Badge tone="neutral">待验收 ({totalChecklistCount} 项)</Badge>
                    )}
                  </div>
                )
              }
            />
            <div className="px-5 py-4">
              {goal ? (
                <div className="mb-3.5 flex items-center justify-between gap-2 rounded-lg border border-line bg-panel2/50 px-3 py-2 text-label">
                  <div className="flex items-center gap-2 truncate">
                    <span className="text-faint">归属目标：</span>
                    <span className="font-medium text-ink truncate">{goal.title}</span>
                  </div>
                  {goal.status ? (
                    /*
                      目标状态用目标自己的词。StatusBadge 是 Agent 的语汇
                      （active=在岗、paused=暂停），套在目标上会把"目标已暂停"
                      读成"这个人被停职了"。
                    */
                    <Badge tone={goal.status === "active" ? "teal" : "neutral"}>
                      {goalStatusLabel(goal.status)}
                    </Badge>
                  ) : null}
                </div>
              ) : null}

              <div className="mb-4">
                <div className="mb-1 text-eyebrow font-medium uppercase tracking-wider text-faint">
                  标准描述
                </div>
                <p className="text-label leading-relaxed text-ink-soft">
                  {task.acceptanceCriteria || "暂无文字验收标准要求。"}
                </p>
              </div>

              {orderedChecklist.length > 0 ? (
                <div className="overflow-hidden rounded-lg border border-line bg-panel2/30">
                  <div className="hidden sm:grid sm:grid-cols-[1.25fr_85px_1fr] items-center gap-3 border-b border-line bg-panel2/80 px-3.5 py-2 text-eyebrow font-semibold uppercase tracking-[0.14em] text-faint">
                    <span>契约规则</span>
                    <span>分类</span>
                    <span>判定结果（Auditor / 模型 / 人工）</span>
                  </div>
                  <div className="divide-y divide-line/70">
                    {orderedChecklist.map(({ item, index, result }) => (
                      <div
                        key={`${item.type}-${index}`}
                        className={`grid grid-cols-1 gap-1 px-3.5 py-2.5 transition-colors sm:grid-cols-[1.25fr_85px_1fr] sm:items-start sm:gap-3 ${
                          result && !result.passed
                            ? "bg-danger/[0.04]"
                            : result?.undetermined
                              ? "bg-accent/[0.03]"
                              : ""
                        }`}
                      >
                        <div className="min-w-0">
                          <span className="text-label leading-relaxed text-ink-soft font-medium">
                            {getChecklistRuleLabel(item)}
                          </span>
                          {item.required ? (
                            <span className="ml-1.5 text-eyebrow font-semibold text-danger">
                              *必选
                            </span>
                          ) : null}
                        </div>

                        <div className="flex items-center gap-1.5 sm:block">
                          <span className="text-eyebrow uppercase tracking-wider text-faint sm:hidden">
                            分类
                          </span>
                          {getChecklistTypeTag(item.type)}
                        </div>

                        <div className="min-w-0 text-label">
                          <span className="mb-0.5 block text-eyebrow uppercase tracking-wider text-faint sm:hidden">
                            判定结果
                          </span>
                          {result ? (
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-1.5">
                                {result.undetermined ? (
                                  <>
                                    <CircleAlert className="size-3.5 shrink-0 text-accent" />
                                    <span className="font-medium text-accent">需人工复核</span>
                                  </>
                                ) : result.passed ? (
                                  <>
                                    <CheckCircle2 className="size-3.5 shrink-0 text-teal" />
                                    <span className="font-medium text-teal">通过</span>
                                  </>
                                ) : (
                                  <>
                                    <XCircle className="size-3.5 shrink-0 text-danger" />
                                    <span className="font-medium text-danger">未通过</span>
                                  </>
                                )}
                              </div>
                              {result.reason ? (
                                <div className="text-label leading-relaxed text-faint">
                                  {result.reason}
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            /*
                              三种规则三种「还没人判」的措辞。judge 项以前落进
                              "待规则核查"，但没有任何规则会去查它——它等的是模型。
                              未配置模型时那一项会一直停在未判定（judge.ts 会写成
                              undetermined），所以文案只说"待"，不承诺会有结论。
                            */
                            <span
                              className={
                                item.type === "manual"
                                  ? "text-accent"
                                  : item.type === "judge"
                                    ? "text-violet"
                                    : "text-faint"
                              }
                              title={
                                item.type === "manual"
                                  ? "由你本人判定：系统没有可执行的规则，也不会替你下结论。"
                                  : item.type === "judge"
                                    ? "待模型判卷：把产物交给已配置的模型阅读并给出结论。没有配置模型时这一项会一直保持未判定，不会因为超时或失败被当作通过。"
                                    : undefined
                              }
                            >
                              {item.type === "manual"
                                ? "需人工复核"
                                : item.type === "judge"
                                  ? "待模型判卷"
                                  : "待规则核查"}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3 text-label text-faint border-t border-line/60 pt-3">
                <span>
                  规则项由 Auditor 自动化核对；「待模型判卷」项由模型判定（未配置模型时保持未判定）；
                  「需人工复核」项由人类主理人确认。
                </span>
                <div className="flex items-center gap-3">
                  <span>预估 {task.estimateMin} 分钟</span>
                  <span>·</span>
                  <span>截止 {dateTime(task.dueAt, tz)}</span>
                </div>
              </div>
            </div>
          </Card>

          {/* 运行前预演：决策由 decideRun 给出，这里只把它翻成人话，不另算一遍 */}
          <Card>
            <CardHeader
              eyebrow="Policy"
              title="运行前预演"
              right={<Badge tone="neutral">只读</Badge>}
            />
            <div className="px-5 py-4">
              <PolicyPreviewPanel taskId={task.id} hasAssignee={Boolean(task.assigneeId)} />
            </div>
          </Card>

          {/* 可核验性：把已经落库、但界面上一直够不到的导出能力铺出来 */}
          <Card>
            <CardHeader
              eyebrow="Verifiability"
              title="可核验性"
              right={
                runs.length > 0 ? (
                  <Badge tone="neutral">{runs.length} 次运行</Badge>
                ) : (
                  <Badge tone="neutral">还没有 run</Badge>
                )
              }
            />
            <div className="px-5 py-4">
              <VerifiabilityPanel
                taskId={task.id}
                timezone={tz}
                hasRuns={runs.length > 0}
                hasChecklist={checklistRows.length > 0}
              />
            </div>
          </Card>

          {claimsRows.length > 0 ? (
            <Card>
              <CardHeader
                eyebrow="Claims"
                title="主张 — 来源核对"
                right={<Badge tone="neutral">{claimsRows.length} 行</Badge>}
              />
              <div className="px-5 py-4">
                <p className="mb-3 text-label leading-relaxed text-faint">
                  这张表由模型写出。机器只验证「引用指向是否存在」，最后一列留空：
                  <span className="text-muted"> 一句原文是否真的支撑这条主张，需要你自己判断。</span>
                </p>
                <div className="overflow-hidden rounded-lg border border-line/70">
                  <div className="grid grid-cols-[1.6fr_1fr_0.9fr] gap-3 border-b border-line/70 bg-sunken/60 px-3 py-2 text-eyebrow uppercase tracking-wide text-faint">
                    <span>主张</span>
                    <span>引用</span>
                    <span>是否被原文支持</span>
                  </div>
                  <div className="divide-y divide-line/60">
                    {claimsRows.map((row, index) => (
                      <div
                        key={`${index}-${row.claim.slice(0, 12)}`}
                        className="grid grid-cols-[1.6fr_1fr_0.9fr] items-start gap-3 px-3 py-2.5"
                      >
                        <span className="text-label leading-relaxed text-ink">
                          {row.claim || "（空）"}
                        </span>
                        <span className="space-y-1">
                          {row.refs.length === 0 ? (
                            <Badge tone="danger">未引用</Badge>
                          ) : (
                            row.refs.map((ref) => {
                              const hit = evidence.find((item) => item.id === ref);
                              return hit ? (
                                <a
                                  key={ref}
                                  href={hit.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="block truncate text-label text-teal hover:underline"
                                  title={hit.title}
                                >
                                  {hit.title}
                                </a>
                              ) : (
                                <Badge key={ref} tone="danger">
                                  找不到 {ref}
                                </Badge>
                              );
                            })
                          )}
                        </span>
                        <span className="text-label text-faint">
                          {row.supported.trim() ? row.supported : "待你核对"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          ) : null}

        </div>

        {/* Right Sidebar: Ownership, Metadata, Approvals, Audit log */}
        <div className="space-y-6">
          <Card>
            <CardHeader eyebrow="Ownership" title="谁负责" />
            <div className="space-y-3 px-5 py-4">
              {assignee ? (
                <Link
                  href={`/cabinet/${assignee.id}`}
                  className="flex items-center gap-2.5 group"
                >
                  <Avatar
                    initials={assignee.avatar}
                    accent={roleMeta(assignee.role).accent}
                    size={32}
                  />
                  <div>
                    <div className="text-label font-medium text-ink group-hover:text-accent transition-colors">
                      {assignee.name}
                    </div>
                    <div className="text-label text-faint">
                      执行 · {assignee.title}
                    </div>
                  </div>
                </Link>
              ) : null}
              {auditor ? (
                <Link
                  href={`/cabinet/${auditor.id}`}
                  className="flex items-center gap-2.5 group"
                >
                  <Avatar
                    initials={auditor.avatar}
                    accent={roleMeta(auditor.role).accent}
                    size={32}
                  />
                  <div>
                    <div className="text-label font-medium text-ink group-hover:text-accent transition-colors">
                      {auditor.name}
                    </div>
                    <div className="text-label text-faint">
                      验收 · {auditor.title}
                    </div>
                  </div>
                </Link>
              ) : null}
              <div className="rounded-md border border-line bg-panel2/50 px-3 py-2 text-label text-muted">
                <ShieldCheck className="mr-1 inline size-3 text-teal" />
                权责隔离：执行者不能验收自己的产物，由 Auditor 独立审查。
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Metadata & Timeline" title="任务属性与时间" />
            <div className="space-y-3 px-5 py-4 text-label">
              <div className="flex items-center justify-between">
                <span className="text-faint">动作类型</span>
                <span className="text-muted">{actionTypeLabel(task.actionType)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-faint">涉及资源</span>
                <span className="text-muted">{resourceLabel(task.resource)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-faint">预估耗时</span>
                <span className="text-muted">{task.estimateMin} 分钟</span>
              </div>
              <div className="flex items-center justify-between border-t border-line/60 pt-2.5">
                <span className="text-faint">创建时间</span>
                <span className="text-muted">{dateTime(task.createdAt, tz)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-faint">截止时间</span>
                <span className="text-muted">{dateTime(task.dueAt, tz)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-faint">最近更新</span>
                <span className="text-muted">{dateTime(task.updatedAt, tz)}</span>
              </div>
            </div>
          </Card>

          {approvals.length > 0 ? (
            <Card className="border-accent/25">
              <CardHeader eyebrow="Approval Required" title="需要批准" />
              <div className="space-y-3 px-5 py-4">
                {approvals.map((approval) => (
                  <div key={approval.id} className="text-label text-muted">
                    <div className="flex items-center gap-2 font-medium text-ink">
                      <CircleAlert className="size-3.5 text-accent" /> {approval.action}
                    </div>
                    <div className="mt-1 leading-relaxed">
                      {String(approval.payload.reason ?? approval.payload.note ?? "")}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <Badge tone={statusTone(approval.status)}>
                        {statusLabel(approval.status)}
                      </Badge>
                      {/*
                        The decision belongs on the page that shows what is being
                        decided. This card used to be the only reachable view of
                        a pending approval on this route while carrying no
                        controls at all, so the reader was asked to approve
                        something they could not approve here. Same component
                        the dashboard uses, unchanged.
                      */}
                      {approval.status === "pending" ? (
                        <ApprovalActions
                          approvalId={approval.id}
                          actionType={approval.action}
                        />
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader eyebrow="Audit Log" title="审计流水记录" />
            <div className="divide-y divide-line">
              {audit.slice(0, 6).map((event) => (
                <div key={event.id} className="px-5 py-2.5">
                  <div className="flex items-center gap-2 text-label">
                    <span className="mono text-muted">{event.action}</span>
                    <span className="text-faint">·</span>
                    <span className="truncate text-faint">{event.actor}</span>
                  </div>
                  <div className="mt-0.5 text-label text-faint">
                    {dateTime(event.createdAt, tz)}
                  </div>
                </div>
              ))}
              {audit.length === 0 ? (
                <div className="px-5 py-4 text-label text-faint">暂无审计流水。</div>
              ) : null}
            </div>
          </Card>

          <Card>
            <div className="flex items-start gap-3 px-5 py-4">
              <Clock3 className="mt-0.5 size-4 text-blue shrink-0" />
              <div className="text-label leading-relaxed text-muted">
                每次运行都会写入一个 <span className="mono text-ink">runLabel</span>
                ，它只是一次尝试的编号，用来在运行记录里定位这次执行的步骤、耗时与花费。上方展示的步骤输入与输出就是当时落库的记录，不是重新执行的结果。
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
