/**
 * Presentation vocabulary shared by every surface.
 *
 * These maps used to be copy-pasted into five pages, which is how "已驳回" and
 * "驳回" ended up meaning the same thing in different screens. The backend owns
 * the *values*; this file owns the *words* and the *colour* for them.
 */

export type BadgeTone =
  | "neutral"
  | "accent"
  | "teal"
  | "danger"
  | "blue"
  | "violet";

export type AgentRole =
  | "chief"
  | "researcher"
  | "coach"
  | "treasurer"
  | "auditor"
  | "apprentice"
  | "critic";

export type RoleMeta = {
  role: AgentRole;
  label: string;
  short: string;
  accent: string;
  objective: string;
};

export const ROLE_META: Record<AgentRole, RoleMeta> = {
  chief: {
    role: "chief",
    label: "Chief of Staff",
    short: "Chief",
    accent: "#e0a83e",
    objective: "目标推进",
  },
  researcher: {
    role: "researcher",
    label: "Researcher",
    short: "Research",
    accent: "#6ea8fe",
    objective: "证据质量",
  },
  coach: {
    role: "coach",
    label: "Coach",
    short: "Coach",
    accent: "#43d6b5",
    objective: "你的学习效果",
  },
  treasurer: {
    role: "treasurer",
    label: "Treasurer",
    short: "Treasury",
    accent: "#c9a6ff",
    objective: "资源效率",
  },
  auditor: {
    role: "auditor",
    label: "Auditor",
    short: "Audit",
    accent: "#f07178",
    objective: "真实性",
  },
  apprentice: {
    role: "apprentice",
    label: "Apprentice",
    short: "Apprentice",
    accent: "#f5c26b",
    objective: "能力增长",
  },
  critic: {
    role: "critic",
    label: "Critic",
    short: "Critic",
    accent: "#9aa4b2",
    objective: "反脆弱",
  },
};

export function roleMeta(role: string): RoleMeta {
  return ROLE_META[role as AgentRole] ?? ROLE_META.critic;
}

export const AUTONOMY_LABELS: Record<number, string> = {
  0: "L0 · 手动",
  1: "L1 · 建议",
  2: "L2 · 审批后执行",
  3: "L3 · 审计后自主",
  4: "L4 · 自驱",
};

export function autonomyLabel(level: number): string {
  return AUTONOMY_LABELS[level] ?? `L${level}`;
}

/** One vocabulary for agents, tasks, approvals, insights, councils, runs. */
export const STATUS_LABELS: Record<string, string> = {
  // agent
  active: "在岗",
  probation: "试用期",
  paused: "暂停",
  retired: "已退休",
  // apprentice lifecycle
  shadowing: "影子学习",
  drafting: "技能草案",
  examining: "考试中",
  practice_passed: "练习通过",
  // task
  planned: "待执行",
  assigned: "已指派",
  awaiting_approval: "待审批",
  approved: "已批准",
  suggested: "建议",
  running: "执行中",
  submitted: "待验收",
  auditing: "验收中",
  accepted: "已通过",
  rejected: "已驳回",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
  // run
  queued: "排队中",
  succeeded: "成功",
  // approval / insight / council
  pending: "待决定",
  proposed: "待采纳",
  applied: "已生效",
  rolled_back: "已回滚",
  open: "进行中",
  decided: "已决议",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function statusTone(status: string): BadgeTone {
  if (["accepted", "done", "succeeded", "applied", "active"].includes(status))
    return "teal";
  if (
    [
      "submitted",
      "auditing",
      "awaiting_approval",
      "suggested",
      "probation",
      "pending",
      "proposed",
      "open",
    ].includes(status)
  )
    return "accent";
  if (["rejected", "failed", "retired", "rolled_back"].includes(status))
    return "danger";
  if (["running", "assigned", "approved"].includes(status)) return "blue";
  if (
    ["paused", "shadowing", "drafting", "examining", "practice_passed"].includes(
      status,
    )
  )
    return "violet";
  return "neutral";
}

export const MEMORY_TYPE_LABEL: Record<string, string> = {
  episodic: "情景",
  semantic: "语义",
  procedural: "程序",
};

export const STANCE_LABEL: Record<string, string> = {
  support: "支持",
  oppose: "反对",
  neutral: "中立",
};

export function stanceLabel(stance: string): string {
  return STANCE_LABEL[stance] ?? "中立";
}

export function stanceTone(stance: string): BadgeTone {
  if (stance === "support") return "teal";
  if (stance === "oppose") return "danger";
  return "accent";
}

/** Acceptance pass rate in whole percent; 0 when nothing has been audited. */
export function passRate(success: number, fail: number): number {
  const total = success + fail;
  return total === 0 ? 0 : Math.round((success / total) * 100);
}

export const NOTIFY_KIND_LABEL: Record<string, string> = {
  rejection: "验收未通过",
  approval: "等待你批准",
  budget: "预算拦截",
  conflict: "记忆冲突",
  council: "内阁会议",
};

export function notifyKindLabel(kind: string): string {
  return NOTIFY_KIND_LABEL[kind] ?? kind;
}

export const DELIVERY_STATUS_LABEL: Record<string, string> = {
  pending: "待投递",
  sending: "投递中",
  sent: "已送达",
  failed: "投递失败",
  skipped: "未投递",
};

export const DELIVERY_STATUS_TONE: Record<string, BadgeTone> = {
  pending: "neutral",
  sending: "blue",
  sent: "teal",
  failed: "danger",
  skipped: "accent",
};

export function deliveryStatusLabel(status: string): string {
  return DELIVERY_STATUS_LABEL[status] ?? status;
}

export function deliveryStatusTone(status: string): BadgeTone {
  return DELIVERY_STATUS_TONE[status] ?? "neutral";
}
