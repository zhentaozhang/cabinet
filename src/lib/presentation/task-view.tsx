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
  RetrievedEvidenceDto,
  StepDto,
  TaskDto,
} from "@/contracts";
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
    default:
      return "自定义契约规则";
  }
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

export function getStatusBannerInfo(
  status: TaskDto["status"],
  hasPendingApproval: boolean,
  hasFailedRun: boolean,
  isAuditorRejected: boolean,
  toolStep?: StepDto,
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
