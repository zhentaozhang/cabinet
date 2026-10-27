import {
  BookOpen,
  Compass,
  Database,
  FileEdit,
  FileText,
  Link2,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";

import type {
  AcceptanceItemDto,
  AcceptanceResultDto,
  RetrievedEvidenceDto,
  RunDto,
  StepDto,
} from "@/contracts";
import type { TaskStatus } from "@/contracts/dto/entities";
import { statusLabel, statusTone, type BadgeTone } from "@/contracts/labels";
import { citedEvidenceIds } from "@/lib/domain/acceptance";
import { isSimulatedSource } from "@/lib/domain/provenance";

/**
 * Presentation rules for the task page, kept out of the page module so they can
 * be tested without rendering React or touching the database.
 *
 * Everything here answers a question the reader will ask while looking at a
 * task: "what is this step?", "is this source real?", "what does this status
 * want from me?". None of it decides anything — the server owns the truth.
 */

export const STEP_META: Record<
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

export const TOOL_STATUS_MAP: Record<
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
    // "Not connected" would be a lie for a request that was sent and failed
    // (governed-call.ts:50 maps network_error here with attempted: true).
    label: "未接通",
    tone: "neutral",
    description:
      "这个工具在当前运行时没有走通（本地没有执行器、外部连接器未配置，或连接器本次请求没成功——看这一步的原因）",
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
  budget_exceeded: {
    label: "预算不足",
    tone: "accent",
    description: "预算预留被拒，工具调用没有发生",
  },
  step_limit: {
    label: "超出步数",
    tone: "accent",
    description: "本次运行已用完工具调用额度，剩余工具未执行",
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

export function getChecklistRuleLabel(item: AcceptanceItemDto): string {
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
    case "judge":
      // 判卷标准是一句自然语言要求，原样显示比改写成"规则"更能解释为什么没通过。
      return `模型判卷：${item.value}`;
    default:
      return "自定义契约规则";
  }
}

/**
 * 清单里"必须判、却没有人能判"的条目。
 *
 * 页面在 needs_review 时要在验收标准之上给出一张卡片，用户第一个问题是
 * "我到底在替谁判？"。答案只能是清单本身：把 required 且 undetermined 的
 * 条目原样列出来，比让他自己往下翻一遍清单再回来点按钮要诚实得多。
 *
 * 文案复用 getChecklistRuleLabel，卡片和下方清单说的是同一句话，不会出现
 * "卡片说人工核验、清单说模型判卷"的分叉。reason 也照抄审计给的理由：那是
 * 它为什么没能判的唯一记录。
 *
 * passed=false 而 undetermined 不为真的条目不算在这里——那种条目已经有结论
 * （不通过），要改的是产物，不是再判一次。
 */
export function pendingDecisionItems(
  report: AcceptanceResultDto[] | null | undefined,
): { statement: string; reason: string }[] {
  if (!report) return [];
  return report
    .filter((entry) => entry.undetermined === true && entry.item.required)
    .map((entry) => ({
      statement: getChecklistRuleLabel(entry.item),
      reason: entry.reason,
    }));
}

export function getChecklistTypeTag(type: AcceptanceItemDto["type"]) {
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
    case "judge":
      // 与"人工复核"共用强调色：两者都是"还没有确定结论、需要人看"的状态。
      return <span className="mono rounded bg-accent/15 border border-accent/30 px-1.5 py-0.5 text-label text-accent">模型判卷</span>;
    default:
      return <span className="mono rounded bg-panel px-1.5 py-0.5 text-label text-muted">规则</span>;
  }
}

export function classifyEvidence(item: RetrievedEvidenceDto) {
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
  // Two different claims: a snippet the provider wrote, and text taken from the
  // page itself. Treating them as one "外部来源" overstates the snippet.
  if (item.kind === "page_extract") {
    return {
      type: "page_extract" as const,
      label: "页面原文",
      tone: "teal" as const,
      icon: FileText,
      desc: "从该页面正文中抓取的连续文字，可直接对照",
    };
  }
  if (item.kind === "search_summary") {
    return {
      type: "search_summary" as const,
      label: "搜索摘要",
      tone: "blue" as const,
      icon: Search,
      desc: "搜索引擎返回的片段，未验证与原文一致",
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

/**
 * What the reader is supposed to do next, in one vocabulary.
 *
 * A category is not a URL and not a permission check: those stay with the
 * existing action components and the server. The category only says which
 * *kind* of move a state calls for, so copy can never promise a button that
 * the state does not have.
 */
export type TaskNextActionCategory =
  | "run"
  | "adopt_suggestion"
  | "review_approval"
  | "wait"
  | "wait_audit"
  | "fix_and_resubmit"
  | "inspect_failure"
  | "review_decision"
  | "mark_done"
  | "none"
  | "unknown";

export type TaskStatusTone = "teal" | "accent" | "danger" | "blue" | "neutral";

/**
 * One row per status the database can actually hold (`TASK_STATUSES` in
 * contracts/dto/entities.ts), keyed by the same union so adding a status
 * without giving it a next action fails type-checking instead of silently
 * falling through to the unknown banner. `blocked` is absent on purpose: it
 * is a grouping idea for lists, never a persisted task state, and adding it
 * here would make the mapping describe a state that cannot occur.
 *
 * Only the next action lives here. The Chinese name and the tone live in
 * contracts/labels.ts — the page already prints status words from there, and
 * a second copy had drifted (approved was 「已批准待执行」 here and 「已批准」
 * there).
 */
const TASK_STATUS_META: Record<
  TaskStatus,
  { nextActionCategory: TaskNextActionCategory }
> = {
  planned: { nextActionCategory: "run" },
  assigned: { nextActionCategory: "run" },
  approved: { nextActionCategory: "run" },
  suggested: { nextActionCategory: "adopt_suggestion" },
  awaiting_approval: { nextActionCategory: "review_approval" },
  running: { nextActionCategory: "wait" },
  submitted: { nextActionCategory: "wait_audit" },
  auditing: { nextActionCategory: "wait_audit" },
  // 验收已经跑完但结论缺一块时，下一步动作是"人来判"，不是"等"也不是"通过"。
  needs_review: { nextActionCategory: "review_decision" },
  rejected: { nextActionCategory: "fix_and_resubmit" },
  failed: { nextActionCategory: "inspect_failure" },
  accepted: { nextActionCategory: "mark_done" },
  done: { nextActionCategory: "none" },
  cancelled: { nextActionCategory: "none" },
};

const NEXT_ACTION_COPY: Record<
  TaskNextActionCategory,
  { label: string; hint: string }
> = {
  run: { label: "启动执行", hint: "点击「执行」让 Agent 推进这次任务。" },
  adopt_suggestion: { label: "采纳建议", hint: "先确认采纳建议方案，才会启动执行。" },
  review_approval: {
    label: "审批放行",
    // No positional reference: the decision is offered wherever the evidence
    // is visible, so pointing at "the approval card" can point at nothing.
    hint: "确认或拒绝这次动作；批准后 Agent 会继续执行，驳回则不会执行。",
  },
  wait: { label: "等待执行", hint: "执行正在进行，完成后会自动送审。" },
  wait_audit: { label: "等待验收", hint: "Auditor 正在对照验收标准裁定，此时无需操作。" },
  review_decision: {
    label: "需要你判定",
    // 说明为什么轮到你：清单里存在"必须判定却没人判定"的条目，Auditor 不代判，
    // 所以结论只能由人给出，并且要留下理由。
    hint: "清单里有必须判定却没人能判的条目（模型没配、判卷超时或人工项）；请给出结论并写明理由。",
  },
  fix_and_resubmit: {
    label: "修改后重交",
    hint: "按驳回原因调整产物，再重新提交或重新执行。",
  },
  inspect_failure: {
    label: "排查失败",
    hint: "先看失败原因与工具调用记录，再决定是否重试。",
  },
  mark_done: { label: "标记完成", hint: "点击「完成」归档任务。" },
  none: { label: "无需操作", hint: "该任务已经结束。" },
  unknown: {
    label: "状态未知，请核对",
    hint: "这个状态不在已知范围内，请先核对任务记录，不要按成功处理。",
  },
};

/**
 * True only for the statuses the domain can persist. Anything else is a data
 * problem, and the UI must say so rather than pick the nearest nice-looking
 * state — an unrecognised row is not "probably done".
 *
 * `hasOwnProperty` rather than a plain lookup: `TASK_STATUS_META["constructor"]`
 * is truthy through the prototype chain, which would dress an unrecognised
 * string up as a known status with no data behind it.
 */
export function isKnownTaskStatus(status: string): status is TaskStatus {
  return Object.prototype.hasOwnProperty.call(TASK_STATUS_META, status);
}

/**
 * The Chinese name and tone come from contracts/labels.ts — the same functions
 * the badges print — so the summary can never disagree with the page around it.
 */
export function getStatusSummary(status: string): {
  status: string;
  known: boolean;
  label: string;
  tone: BadgeTone;
  nextActionCategory: TaskNextActionCategory;
} {
  if (!isKnownTaskStatus(status)) {
    return {
      status,
      known: false,
      label: `未知状态（${status}）`,
      tone: "neutral",
      nextActionCategory: "unknown",
    };
  }
  return {
    status,
    known: true,
    label: statusLabel(status),
    tone: statusTone(status),
    nextActionCategory: TASK_STATUS_META[status].nextActionCategory,
  };
}

/**
 * Whether the page says a run failed, and where it shows why.
 *
 * The banner and the reason panel used to ask two different questions
 * (`status === "failed" || failedRun` versus `status === "failed" && reason`).
 * Recovery (server/services/commands/tasks/recovery.ts) marks the interrupted
 * run failed and then rewinds the task row to `planned`, so the banner promised
 * "the reason is below" while the panel was skipped — the reason was only
 * findable in the run timeline. One function now decides both, and it picks
 * wording that matches who actually failed: the task, or only its last run.
 */
export function resolveFailurePresentation({
  taskStatus,
  hasFailedRun,
  failureReason,
  isRejected,
}: {
  taskStatus: string;
  hasFailedRun: boolean;
  failureReason: string | undefined;
  isRejected: boolean;
}): {
  showBanner: boolean;
  showPanel: boolean;
  title: string;
  tone: TaskStatusTone;
} {
  const showBanner = taskStatus === "failed" || hasFailedRun;
  if (!showBanner) {
    return { showBanner: false, showPanel: false, title: "", tone: "neutral" };
  }
  return {
    showBanner,
    // A rejection card already explains the outcome; two admonitions that
    // disagree about the cause would be worse than one.
    showPanel: Boolean(failureReason) && !isRejected,
    title: failureTitle(taskStatus),
    tone: "danger",
  };
}

function failureTitle(taskStatus: string): string {
  if (taskStatus === "failed") return "执行中断 / 失败原因";
  // Recovery rewinds to a not-yet-started state; nothing is running any more.
  if (
    taskStatus === "planned" ||
    taskStatus === "assigned" ||
    taskStatus === "approved" ||
    taskStatus === "suggested"
  ) {
    return "上次运行失败，任务已回退到待执行，可以重试";
  }
  return "本次运行失败，失败原因如下";
}

/**
 * Copy for a next-action category. The page reads the category off the banner
 * rather than off the raw status, because the banner already folds in evidence
 * the status alone cannot show — a failed run while the task row still says
 * `running`, or a pending approval. Otherwise the banner could announce a
 * failure while the line beneath it said "wait".
 */
export function getNextActionCopy(category: TaskNextActionCategory): {
  category: TaskNextActionCategory;
  label: string;
  hint: string;
} {
  return { category, ...NEXT_ACTION_COPY[category] };
}

export function getStatusNextAction(status: string): {
  category: TaskNextActionCategory;
  label: string;
  hint: string;
} {
  return getNextActionCopy(getStatusSummary(status).nextActionCategory);
}

export function getStatusBannerInfo(
  status: string,
  hasPendingApproval: boolean,
  hasFailedRun: boolean,
  isAuditorRejected: boolean,
  toolStep?: StepDto,
): {
  badgeLabel: string;
  badgeTone: TaskStatusTone;
  title: string;
  description: string;
  bannerBorderClass: string;
  bannerBgClass: string;
  nextActionCategory: TaskNextActionCategory;
} {
  if (isAuditorRejected || status === "rejected") {
    return {
      badgeLabel: "未通过需修改",
      badgeTone: "danger",
      title: "Auditor 驳回了当前产物",
      description: "交付内容未能通过验收标准的契约检验，请根据下方驳回原因调整内容后重新提交或重新执行。",
      bannerBorderClass: "border-danger/35",
      bannerBgClass: "bg-danger/[0.05]",
      nextActionCategory: "fix_and_resubmit",
    };
  }

  if (status === "failed" || hasFailedRun) {
    return {
      badgeLabel: "执行失败",
      badgeTone: "danger",
      // Run-scoped, not task-scoped: after a recovery rewind the task row is
      // back to `planned` and saying "the task failed" would be false.
      title: "本次运行中断或发生异常",
      // Points at the reason panel and the run timeline, both of which are
      // always rendered below (the panel now shares the banner's condition).
      description: "运行没有正常结束，未能交付产物。失败原因与工具调用细节见下方失败原因与运行记录。",
      bannerBorderClass: "border-danger/35",
      bannerBgClass: "bg-danger/[0.05]",
      nextActionCategory: "inspect_failure",
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
      nextActionCategory: "review_approval",
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
      nextActionCategory: "adopt_suggestion",
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
      nextActionCategory: "wait",
    };
  }

  if (status === "submitted" || status === "auditing") {
    // `submitted` means the product is queued for review; only `auditing` means
    // the review is actually in flight. Saying "正在裁定" for a queued product
    // would invent progress the persisted state does not show.
    const isAuditing = status === "auditing";
    return {
      badgeLabel: isAuditing ? "验收中" : "等待 Auditor 验收",
      badgeTone: "accent",
      title: isAuditing ? "Auditor 正在逐项裁定" : "产物已提交，等待独立审查",
      description: isAuditing
        ? "Auditor 正在对照验收标准与 Checklist 规则逐项核对，判定结果会写回下方验收清单。"
        : "产物已提交，等待 Auditor 按验收标准与 Checklist 规则开始裁定，此时无需操作。",
      bannerBorderClass: "border-accent/35",
      bannerBgClass: "bg-accent/[0.05]",
      nextActionCategory: "wait_audit",
    };
  }

  if (status === "accepted") {
    return {
      badgeLabel: "验收通过",
      badgeTone: "teal",
      title: "Auditor 已放行这次产物",
      description:
        "规则核对已完成，点击右侧「完成」归档任务；标记为「需人工复核」的项仍以验收清单里的记录为准。",
      bannerBorderClass: "border-teal/35",
      bannerBgClass: "bg-teal/[0.05]",
      nextActionCategory: "mark_done",
    };
  }

  if (status === "done") {
    return {
      badgeLabel: "任务已完成",
      badgeTone: "teal",
      title: "交付物与审计记录已归档",
      description: "任务已全流程闭环；产物、运行记录与审计流水都保留在这条任务里，可随时回看。",
      bannerBorderClass: "border-teal/35",
      bannerBgClass: "bg-teal/[0.05]",
      nextActionCategory: "none",
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
      nextActionCategory: "none",
    };
  }

  // `approved` is not the same as a fresh task: a human already cleared the
  // action, so the only remaining move is to start it.
  if (status === "approved") {
    return {
      badgeLabel: "已批准待执行",
      badgeTone: "blue",
      title: "审批已通过，可以启动执行",
      description: "这次动作已被主理人放行，点击右上角「执行」继续推进任务。",
      bannerBorderClass: "border-blue/35",
      bannerBgClass: "bg-blue/[0.05]",
      nextActionCategory: "run",
    };
  }

  if (status === "planned" || status === "assigned") {
    return {
      badgeLabel: status === "assigned" ? "准备就绪" : "待执行",
      badgeTone: "neutral",
      title: "前置准备就绪，等待启动",
      description: "目标与验收标准已明确，点击右上角「执行」启动自动化工作流。",
      bannerBorderClass: "border-line",
      bannerBgClass: "bg-panel2/40",
      nextActionCategory: "run",
    };
  }

  // 验收跑完了，但结论缺一块：清单里有"必须判定却没人判定"的条目。
  // 这条横幅不能借 success 语气：没有结论 ≠ 通过，下一步是人给结论。
  if (status === "needs_review") {
    return {
      badgeLabel: "待你判定",
      badgeTone: "accent",
      title: "验收缺少结论，需要你判定",
      description:
        "Auditor 已完成能自动判定的部分；清单里还有必须判定却没有结论的条目（模型未配置、判卷超时或人工项）。请查看产物后给出结论并写明理由。",
      bannerBorderClass: "border-accent/35",
      bannerBgClass: "bg-accent/[0.05]",
      nextActionCategory: "review_decision",
    };
  }

  // Anything else is a status this build does not know. Say so plainly and
  // never borrow the success tone — a row we cannot read is not a win.
  return {
    badgeLabel: "状态未知",
    badgeTone: "neutral",
    title: `无法识别的任务状态：${status || "（空）"}`,
    description:
      "这个状态不在 Cabinet 已知的任务状态范围内。请核对任务记录或数据迁移，不要按「已完成」或「已通过」处理。",
    bannerBorderClass: "border-line2",
    bannerBgClass: "bg-panel2/40",
    nextActionCategory: "unknown",
  };
}

/**
 * The current attempt, and everything that must be derived from it alone.
 *
 * The page used to search *all* runs for a failure and all steps for a tool
 * step. Two things went wrong with that:
 *
 *  1. A task that failed once and was then retried successfully still rendered
 *     the 「执行失败」 banner, because `getStatusBannerInfo` treats "some run
 *     failed" as a fact about now.
 *  2. `steps` arrives ordered by `idx` across every run, so the first tool step
 *     in the list can belong to an older attempt — showing a stale connector
 *     status and a stale reason under a task that has since succeeded.
 *
 * History is not deleted: the run timeline still lists every attempt with its
 * own status. It just no longer votes on what the task currently *is*.
 */
export function getCurrentAttempt(
  runs: readonly Pick<RunDto, "id" | "status" | "error">[],
  steps: readonly StepDto[],
): {
  latestRun: Pick<RunDto, "id" | "status" | "error"> | undefined;
  latestRunSteps: StepDto[];
  failedRun: Pick<RunDto, "id" | "status" | "error"> | undefined;
  failedStep: StepDto | undefined;
  toolStep: StepDto | undefined;
  /** Why the current run did (or did not) reach an external source. */
  toolReason: string;
  failureReason: string | undefined;
} {
  // `runs` arrives oldest-first, so the last row is the attempt in progress.
  const latestRun = runs.length > 0 ? runs[runs.length - 1] : undefined;
  const latestRunSteps = latestRun
    ? steps.filter((step) => step.runId === latestRun.id)
    : [];

  const failedRun =
    latestRun && (latestRun.status === "failed" || latestRun.error)
      ? latestRun
      : undefined;

  const failedStep = latestRunSteps.find((step) => {
    const output = step.output as Record<string, unknown> | null;
    return output?.status === "failed" || Boolean(output?.error);
  });

  const toolStep = latestRunSteps.find((step) => step.type === "tool");
  const toolOutput = (toolStep?.output ?? {}) as Record<string, unknown>;
  // No run at all is not "a run that skipped retrieval" — the page used to
  // print a fact about a run that does not exist.
  const toolReason = !latestRun
    ? "这个任务还没有运行记录。"
    : typeof toolOutput.reason === "string"
      ? toolOutput.reason
      : "这次运行没有调用检索工具。";

  const failedOutput = failedStep?.output as Record<string, unknown> | null;
  const failureReason =
    failedRun?.error ||
    (typeof failedOutput?.error === "string" ? failedOutput.error : undefined) ||
    (typeof failedOutput?.reason === "string" ? failedOutput.reason : undefined) ||
    // A task marked failed with no run error still needs a sentence to show.
    (failedRun ? toolReason : undefined);

  return {
    latestRun,
    latestRunSteps,
    failedRun,
    failedStep,
    toolStep,
    toolReason,
    failureReason,
  };
}

/**
 * How a deliverable body relates to the evidence rows that were persisted.
 *
 * Three outcomes, deliberately kept apart:
 *
 *  - `cited`      — the text points at a row that exists.
 *  - `unresolved` — the text points at an id that was never stored (a model can
 *                   invent `[cite:evd_…]`, so this is a fabrication signal).
 *  - `uncited`    — a row exists but no deliverable mentions it.
 *
 * A `cited` entry means "this sentence claims to rest on that source". It does
 * NOT mean the source supports the sentence; nothing in the DTO can prove that.
 * Citations are parsed by `citedEvidenceIds` so the page and the Auditor agree.
 */
export type CitationRelationship = {
  /** Cited ids that resolve to a stored row, in first-mention order. */
  cited: string[];
  /** Cited ids with no stored row — possibly fabricated or already cleaned up. */
  unresolved: string[];
  /** Stored ids that no deliverable cites, in stored order. */
  uncited: string[];
};

export function getCitationRelationship(
  content: string,
  storedEvidenceIds: readonly string[],
): CitationRelationship {
  const stored = new Set(storedEvidenceIds);
  const cited: string[] = [];
  const unresolved: string[] = [];

  for (const id of citedEvidenceIds(content)) {
    if (stored.has(id)) {
      if (!cited.includes(id)) cited.push(id);
    } else if (!unresolved.includes(id)) {
      unresolved.push(id);
    }
  }

  const citedSet = new Set(cited);
  return {
    cited,
    unresolved,
    uncited: storedEvidenceIds.filter((id) => !citedSet.has(id)),
  };
}

export type TaskCitationSummary = CitationRelationship & {
  /** Deliverables whose body carries at least one citation marker. */
  artifactsWithCitations: number;
  /** Deliverables with no citation markers at all — claims rest on nothing. */
  artifactsWithoutCitations: number;
  /** One sentence stating what the citation state does and does not prove. */
  groundingNote: string;
};

/**
 * The whole-task view of the relationship, so the evidence card and the
 * deliverable card cannot disagree about which rows are used.
 */
export function summarizeTaskCitations(
  artifacts: readonly { content: string }[],
  storedEvidenceIds: readonly string[],
): TaskCitationSummary {
  const cited: string[] = [];
  const unresolved: string[] = [];
  let artifactsWithCitations = 0;
  let artifactsWithoutCitations = 0;

  for (const artifact of artifacts) {
    const relation = getCitationRelationship(artifact.content, storedEvidenceIds);
    if (relation.cited.length + relation.unresolved.length === 0) {
      artifactsWithoutCitations += 1;
    } else {
      artifactsWithCitations += 1;
    }
    for (const id of relation.cited) if (!cited.includes(id)) cited.push(id);
    for (const id of relation.unresolved) if (!unresolved.includes(id)) unresolved.push(id);
  }

  const citedSet = new Set(cited);
  const uncited = storedEvidenceIds.filter((id) => !citedSet.has(id));

  let groundingNote: string;
  if (unresolved.length > 0) {
    groundingNote = `有 ${unresolved.length} 个引用标记找不到对应证据，可能是编造或证据已被清理，需人工核实。`;
  } else if (artifactsWithoutCitations > 0) {
    groundingNote = `有 ${artifactsWithoutCitations} 份产物未引用任何来源，结论未与证据绑定；证据存在不等于结论成立。`;
  } else if (cited.length > 0) {
    groundingNote = `产物引用了 ${cited.length} 条证据；引用只表示指向，是否真的支撑结论仍需人工判断。`;
  } else {
    groundingNote = "当前没有可核对的引用关系。";
  }

  return {
    cited,
    unresolved,
    uncited,
    artifactsWithCitations,
    artifactsWithoutCitations,
    groundingNote,
  };
}