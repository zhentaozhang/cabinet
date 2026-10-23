import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Compass,
  Database,
  ExternalLink,
  FileEdit,
  FileText,
  Link2,
  Play,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react";
import { fetchTaskPage } from "@/lib/api/pages";
import { roleMeta, statusLabel, statusTone } from "@/lib/agents";
import { dateTime, money, timeOnly } from "@/lib/format";
import { isSimulatedSource, sourceLabel } from "@/lib/domain/provenance";
import type {
  AcceptanceItemDto,
  RetrievedEvidenceDto,
  StepDto,
  TaskDto,
} from "@/contracts";
import {
  Avatar,
  Badge,
  Card,
  CardHeader,
  EmptyState,
} from "@/components/ui";
import { ArtifactSubmitForm, TaskActions } from "@/components/actions";
import { Markdown } from "@/components/markdown";

export const metadata: Metadata = {
  title: "Task · Cabinet",
};

export const dynamic = "force-dynamic";

const STEP_META: Record<
  string,
  {
    label: string;
    description: string;
    icon: typeof BookOpen;
    toneClass: string;
    bgClass: string;
    borderClass: string;
  }
> = {
  context: {
    label: "收集上下文",
    description: "加载目标背景、前置记忆与指令约束",
    icon: BookOpen,
    toneClass: "text-blue",
    bgClass: "bg-blue/10",
    borderClass: "border-blue/30",
  },
  plan: {
    label: "制定计划",
    description: "规划执行路径与质量闸门",
    icon: Compass,
    toneClass: "text-accent",
    bgClass: "bg-accent/10",
    borderClass: "border-accent/30",
  },
  tool: {
    label: "检索与工具",
    description: "调用外部连接器获取可信来源与实时数据",
    icon: Wrench,
    toneClass: "text-violet",
    bgClass: "bg-violet/10",
    borderClass: "border-violet/30",
  },
  draft: {
    label: "撰写产物",
    description: "按要求生成交付草稿与结构化内容",
    icon: FileEdit,
    toneClass: "text-teal",
    bgClass: "bg-teal/10",
    borderClass: "border-teal/30",
  },
  submit: {
    label: "提交送审",
    description: "封存产物并触发独立验收审查",
    icon: Send,
    toneClass: "text-muted",
    bgClass: "bg-panel2",
    borderClass: "border-line",
  },
  audit: {
    label: "Auditor 验收",
    description: "对照验收标准进行规则校验与判定",
    icon: ShieldCheck,
    toneClass: "text-danger",
    bgClass: "bg-danger/10",
    borderClass: "border-danger/30",
  },
};

const TOOL_STATUS_MAP: Record<
  string,
  {
    label: string;
    tone: "teal" | "neutral" | "accent" | "danger";
    description: string;
  }
> = {
  ok: {
    label: "已执行",
    tone: "teal",
    description: "工具执行成功并返回有效数据",
  },
  not_connected: {
    label: "未连接",
    tone: "neutral",
    description: "当前环境未建立有效外部连接",
  },
  skipped: {
    label: "未执行",
    tone: "neutral",
    description: "该步骤跳过外部检索，直接基于前置上下文推进",
  },
  not_configured: {
    label: "未配置",
    tone: "neutral",
    description: "检索连接器未配置 API Key 或凭据",
  },
  unauthorized: {
    label: "密钥被拒",
    tone: "danger",
    description: "API Key 无效或权限不足",
  },
  rate_limited: {
    label: "被限流",
    tone: "accent",
    description: "上游服务请求频次超限",
  },
  timeout: {
    label: "超时",
    tone: "danger",
    description: "工具请求超时未响应",
  },
  invalid_response: {
    label: "响应异常",
    tone: "danger",
    description: "返回数据无法解析或格式不符",
  },
  network_error: {
    label: "网络错误",
    tone: "danger",
    description: "网络连接中断",
  },
  failed: {
    label: "执行失败",
    tone: "danger",
    description: "工具调用异常失败",
  },
};

function getChecklistRuleLabel(item: AcceptanceItemDto): string {
  switch (item.type) {
    case "contains":
      return `包含关键词「${item.value}」`;
    case "min_words":
      return `正文长度不少于 ${item.value} 字`;
    case "min_sources":
      return `引用外部来源不少于 ${item.value} 个`;
    case "min_evidence":
      return `落库引用证据不少于 ${item.value} 条`;
    case "section":
      return `包含核心章节「${item.value}」`;
    case "manual":
      return `人工核验项：${item.note}`;
    default:
      return "自定义契约规则";
  }
}

function getChecklistTypeTag(type: AcceptanceItemDto["type"]) {
  switch (type) {
    case "contains":
      return <span className="mono rounded bg-panel px-1.5 py-0.5 text-label text-muted">关键词</span>;
    case "min_words":
      return <span className="mono rounded bg-panel px-1.5 py-0.5 text-label text-muted">字数要求</span>;
    case "min_sources":
      return <span className="mono rounded bg-panel px-1.5 py-0.5 text-label text-muted">外部链接</span>;
    case "min_evidence":
      return <span className="mono rounded bg-panel px-1.5 py-0.5 text-label text-muted">证据落库</span>;
    case "section":
      return <span className="mono rounded bg-panel px-1.5 py-0.5 text-label text-muted">章节规范</span>;
    case "manual":
      return <span className="mono rounded bg-accent/15 border border-accent/30 px-1.5 py-0.5 text-label text-accent">人工复核</span>;
    default:
      return <span className="mono rounded bg-panel px-1.5 py-0.5 text-label text-muted">规则</span>;
  }
}

function classifyEvidence(item: RetrievedEvidenceDto) {
  const isSimulated =
    isSimulatedSource(item.provider) ||
    item.provider === "demo" ||
    item.provider === "mock" ||
    item.provider === "seed" ||
    item.provider === "demo_search";
  const isDb =
    item.kind === "db" ||
    item.kind === "memory" ||
    item.kind === "database" ||
    item.provider === "database" ||
    item.provider === "cabinet";
  const hasUrl = Boolean(item.url && item.url.startsWith("http"));

  if (isSimulated) {
    return {
      type: "simulated" as const,
      label: "模拟演示源",
      tone: "neutral" as const,
      icon: Sparkles,
      desc: "该条目来自演示预置数据，非实时互联网检索",
    };
  }
  if (isDb) {
    return {
      type: "database" as const,
      label: "内部知识库引用",
      tone: "blue" as const,
      icon: Database,
      desc: "来自 Cabinet 本地记忆库或知识资产",
    };
  }
  if (hasUrl) {
    return {
      type: "external" as const,
      label: "真实外部来源",
      tone: "teal" as const,
      icon: Link2,
      desc: "经检索连接器实时获取的网络源证据",
    };
  }
  return {
    type: "citation" as const,
    label: "数据源引用",
    tone: "neutral" as const,
    icon: Link2,
    desc: "静态外部引用条目",
  };
}

function getStatusBannerInfo(
  status: TaskDto["status"],
  hasPendingApproval: boolean,
  hasFailedRun: boolean,
  isAuditorRejected: boolean,
  toolStep?: StepDto
): {
  badgeLabel: string;
  badgeTone: "teal" | "accent" | "danger" | "blue" | "neutral";
  title: string;
  description: string;
  bannerBorderClass: string;
  bannerBgClass: string;
} {
  if (isAuditorRejected || status === "rejected") {
    return {
      badgeLabel: "未通过需修改",
      badgeTone: "danger",
      title: "Auditor 驳回了当前产物",
      description: "交付内容未能通过验收标准的契约检验，请根据下方驳回原因调整内容后重新提交或重新执行。",
      bannerBorderClass: "border-danger/35",
      bannerBgClass: "bg-danger/[0.05]",
    };
  }

  if (status === "failed" || hasFailedRun) {
    return {
      badgeLabel: "执行失败",
      badgeTone: "danger",
      title: "任务执行过程中断或发生异常",
      description: "执行过程遇到错误，未能成功交付产物。请检查下方失败原因与工具调用细节。",
      bannerBorderClass: "border-danger/35",
      bannerBgClass: "bg-danger/[0.05]",
    };
  }

  if (hasPendingApproval || status === "awaiting_approval") {
    return {
      badgeLabel: "等待你审核",
      badgeTone: "accent",
      title: "动作超出自治阈值，等待人工审批",
      description: "该操作涉及高风险动作或超出预算限额，系统已暂停推进，等待主理人审批放行。",
      bannerBorderClass: "border-accent/35",
      bannerBgClass: "bg-accent/[0.05]",
    };
  }

  if (status === "suggested") {
    return {
      badgeLabel: "等待你审核",
      badgeTone: "accent",
      title: "已生成建议方案（L1 级自治）",
      description: "Agent 已起草建议方案，当前自治等级要求由主理人确认采纳后方可继续。",
      bannerBorderClass: "border-accent/35",
      bannerBgClass: "bg-accent/[0.05]",
    };
  }

  if (status === "running") {
    const isToolRunning =
      toolStep &&
      (toolStep.output as Record<string, unknown> | null)?.status === "running";
    return {
      badgeLabel: isToolRunning ? "等待检索" : "执行中",
      badgeTone: "blue",
      title: isToolRunning ? "正在调用外部连接器执行检索" : "Agent 正在推进执行工作流",
      description: "正在收集前置上下文、检索可信来源或撰写交付物，完成后将自动送审。",
      bannerBorderClass: "border-blue/35",
      bannerBgClass: "bg-blue/[0.05]",
    };
  }

  if (status === "submitted" || status === "auditing") {
    return {
      badgeLabel: "等待 Auditor 验收",
      badgeTone: "accent",
      title: "产物已提交，等待独立审查",
      description: "Auditor 正在对照验收标准与 Checklist 规则逐项进行合格性裁定。",
      bannerBorderClass: "border-accent/35",
      bannerBgClass: "bg-accent/[0.05]",
    };
  }

  if (status === "accepted") {
    return {
      badgeLabel: "验收通过",
      badgeTone: "teal",
      title: "所有验收标准均已满足",
      description: "Auditor 已确认产物符合质量规范，点击右侧「完成」归档任务并同步记忆。",
      bannerBorderClass: "border-teal/35",
      bannerBgClass: "bg-teal/[0.05]",
    };
  }

  if (status === "done") {
    return {
      badgeLabel: "任务已完成",
      badgeTone: "teal",
      title: "交付物与审计记录已归档",
      description: "任务已全流程闭环，产物与经验数据已沉淀入库。",
      bannerBorderClass: "border-teal/35",
      bannerBgClass: "bg-teal/[0.05]",
    };
  }

  if (status === "cancelled") {
    return {
      badgeLabel: "已取消",
      badgeTone: "neutral",
      title: "任务已终止",
      description: "该任务已取消，未产生后续动作。",
      bannerBorderClass: "border-line",
      bannerBgClass: "bg-panel2/40",
    };
  }

  return {
    badgeLabel: status === "assigned" ? "准备就绪" : "待执行",
    badgeTone: "neutral",
    title: "前置准备就绪，等待启动",
    description: "目标与验收标准已明确，点击右上角「执行」启动自动化工作流。",
    bannerBorderClass: "border-line",
    bannerBgClass: "bg-panel2/40",
  };
}

export default async function TaskPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await fetchTaskPage(id);
  if (!data) notFound();
  const tz = data.timezone;
  const { task, goal, assignee, auditor, runs, steps, artifacts, evidence, approvals, audit } = data;

  const toolStep = steps.find((step) => step.type === "tool");
  const toolOutput = (toolStep?.output ?? {}) as Record<string, unknown>;
  const toolReason =
    typeof toolOutput.reason === "string"
      ? toolOutput.reason
      : "这次运行没有调用检索工具。";

  const stepsByRun = new Map<string, typeof steps>();
  for (const step of steps) {
    const list = stepsByRun.get(step.runId) ?? [];
    list.push(step);
    stepsByRun.set(step.runId, list);
  }

  // Audits & rejections
  const latestAudit = audit.find((a) => a.action.startsWith("audit."));
  const latestAuditReject = audit.find((a) => a.action === "audit.reject");
  const isRejected = task.status === "rejected" || latestAudit?.action === "audit.reject";
  const rejectionReason =
    ((latestAuditReject?.after ?? latestAudit?.after) as Record<string, unknown> | null)?.reason as string | undefined;

  // Runs & failures
  const failedRun = [...runs].reverse().find((r) => r.status === "failed" || r.error);
  const failedStep = steps.find(
    (s) =>
      (s.output as Record<string, unknown> | null)?.status === "failed" ||
      (s.output as Record<string, unknown> | null)?.error
  );
  const failureReason =
    failedRun?.error ||
    ((failedStep?.output as Record<string, unknown> | null)?.error as string | undefined) ||
    ((failedStep?.output as Record<string, unknown> | null)?.reason as string | undefined) ||
    (task.status === "failed" ? toolReason : undefined);

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

  const bannerInfo = getStatusBannerInfo(
    task.status,
    approvals.some((a) => a.status === "pending"),
    task.status === "failed" || Boolean(failedRun),
    isRejected,
    toolStep
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
              · 风险等级 {task.riskLevel}
            </span>
          ) : null}
        </div>

        <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-ink">
          {task.title}
        </h1>
        {task.description ? (
          <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-muted">
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
              <span className="text-xs font-semibold text-ink">
                {bannerInfo.title}
              </span>
            </div>
            <p className="mt-1.5 text-label leading-relaxed text-muted">
              {bannerInfo.description}
            </p>
          </div>

          <div className="shrink-0">
            <TaskActions taskId={task.id} status={task.status} />
          </div>
        </div>

        {/* Hoisted alert reason if rejected: user never has to scroll through long logs */}
        {isRejected ? (
          <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-3.5">
            <div className="flex items-start gap-2.5">
              <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-danger">
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
                        className="inline-flex items-center gap-1 rounded border border-danger/30 bg-danger/20 px-2 py-0.5 text-label text-danger"
                      >
                        <XCircle className="size-3 shrink-0" />
                        <span>{getChecklistRuleLabel(item)}</span>
                        {result?.reason ? (
                          <span className="opacity-80">（{result.reason}）</span>
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
        {task.status === "failed" && failureReason && !isRejected ? (
          <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-3.5">
            <div className="flex items-start gap-2.5">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-danger">
                  执行中断 / 失败原因
                </div>
                <div className="mt-1 text-label leading-relaxed text-ink-soft font-mono">
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
                <div className="text-xs font-semibold text-accent">
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
          {/* Requirement 2: Contract First (验收标准前置) */}
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
                    <Badge tone={statusTone(goal.status)}>
                      {statusLabel(goal.status)}
                    </Badge>
                  ) : null}
                </div>
              ) : null}

              <div className="mb-4">
                <div className="mb-1 text-eyebrow font-medium uppercase tracking-wider text-faint">
                  标准描述
                </div>
                <p className="text-xs leading-relaxed text-ink-soft">
                  {task.acceptanceCriteria || "暂无文字验收标准要求。"}
                </p>
              </div>

              {orderedChecklist.length > 0 ? (
                <div className="overflow-hidden rounded-lg border border-line bg-panel2/30">
                  <div className="grid grid-cols-[1.25fr_85px_1fr] items-center gap-3 border-b border-line bg-panel2/80 px-3.5 py-2 text-eyebrow font-semibold uppercase tracking-[0.14em] text-faint">
                    <span>契约规则</span>
                    <span>分类</span>
                    <span>判定结果（Auditor / 人工）</span>
                  </div>
                  <div className="divide-y divide-line/70">
                    {orderedChecklist.map(({ item, index, result }) => (
                      <div
                        key={`${item.type}-${index}`}
                        className={`grid grid-cols-[1.25fr_85px_1fr] items-start gap-3 px-3.5 py-2.5 transition-colors ${
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

                        <div>{getChecklistTypeTag(item.type)}</div>

                        <div className="min-w-0 text-label">
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
                            <span
                              className={
                                item.type === "manual" ? "text-accent" : "text-faint"
                              }
                            >
                              {item.type === "manual" ? "需人工复核" : "待规则核查"}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3 text-label text-faint border-t border-line/60 pt-3">
                <span>规则项由 Auditor 自动化核对；「需人工复核」项由人类主理人确认。</span>
                <div className="flex items-center gap-3">
                  <span>预估 {task.estimateMin} 分钟</span>
                  <span>·</span>
                  <span>截止 {dateTime(task.dueAt, tz)}</span>
                </div>
              </div>
            </div>
          </Card>

          {/* Requirement 4: Deliverables & Artifacts (交付产物) */}
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
                  title="暂无交付产物"
                  hint="点击上方「执行」让 Agent 生成第一版产物，或在上方「提交我的答案」中直接撰写。"
                />
              </div>
            ) : (
              <div className="divide-y divide-line">
                {artifacts.map((artifact, idx) => (
                  <div key={artifact.id} className="px-5 py-4">
                    <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <FileText className="size-4 text-teal shrink-0" />
                        <span className="text-xs font-semibold text-ink">
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
                      </div>
                      <span className="text-label text-faint">{dateTime(artifact.createdAt, tz)}</span>
                    </div>

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
                ))}
              </div>
            )}
          </Card>

          {/* Requirement 4: Grounding & Evidence (检索证据与外部来源) */}
          <Card>
            <CardHeader
              eyebrow="Grounding & Evidence"
              title="检索证据与外部来源"
              right={
                evidence.length > 0 ? (
                  <Badge tone="teal">{evidence.length} 条有效证据</Badge>
                ) : (
                  <Badge tone="neutral">无检索证据</Badge>
                )
              }
            />
            {evidence.length === 0 ? (
              <div className="px-5 py-6 text-center">
                <div className="mx-auto mb-2 flex size-9 items-center justify-center rounded-full border border-line bg-panel2 text-faint">
                  <Search className="size-4" />
                </div>
                <div className="text-xs font-medium text-ink">这次运行没有落库外部证据</div>
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
                                  className="group inline-flex items-center gap-1 text-xs font-medium text-ink hover:text-accent truncate underline decoration-line2 underline-offset-2"
                                >
                                  <span className="truncate">{item.title}</span>
                                  <ExternalLink className="size-3 shrink-0 text-faint group-hover:text-accent" />
                                </a>
                              ) : (
                                <span className="text-xs font-medium text-ink truncate">
                                  {item.title}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
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
                            <div className="mt-2 text-label text-faint truncate mono">
                              <a
                                href={item.url}
                                target="_blank"
                                rel="noreferrer noopener"
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

          {/* Requirement 3: Execution Timeline & Tool Steps (运行过程) */}
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
                                ? "bg-danger shadow-[0_0_8px_rgba(234,85,85,0.5)]"
                                : "bg-blue shadow-[0_0_8px_rgba(91,159,248,0.5)]"
                          }`}
                        />
                        <span className="mono text-label font-medium text-ink">
                          Run #{runs.length - runIndex}
                        </span>
                        <span className="mono text-label text-faint">({run.id})</span>
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
                          <span className="font-mono">{run.error}</span>
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
                                  <div className="mt-2 grid gap-2.5 sm:grid-cols-2">
                                    <div>
                                      <div className="mb-1 text-eyebrow font-medium uppercase text-faint">
                                        输入 Input
                                      </div>
                                      <pre className="max-h-56 overflow-x-auto rounded-lg border border-line bg-sunken p-2.5 text-label leading-relaxed text-muted font-mono">
                                        {JSON.stringify(step.input, null, 2)}
                                      </pre>
                                    </div>
                                    <div>
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

                      {/* Replay key */}
                      {run.replayKey ? (
                        <div className="mt-3 flex items-center gap-1.5 border-t border-line/60 pt-2.5 text-label text-faint">
                          <Play className="size-3 text-muted" />
                          <span>回放标识 replayKey:</span>
                          <span className="mono text-ink select-all">{run.replayKey}</span>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
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
                <span className="mono text-muted">{task.actionType}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-faint">涉及资源</span>
                <span className="text-muted">{task.resource}</span>
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
                    <Badge
                      tone={approval.status === "pending" ? "accent" : "neutral"}
                      className="mt-2"
                    >
                      {approval.status}
                    </Badge>
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
                每次运行均严格保证可重放性：使用 <span className="mono text-ink">replayKey</span>{" "}
                可在沙箱中完整复现推理步骤、检索输入与判定结果，确保执行过程透明可追溯。
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
