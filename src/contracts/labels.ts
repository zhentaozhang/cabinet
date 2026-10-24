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

/**
 * Memory kinds are a taxonomy, not a lifecycle — kept apart from STATUS_LABELS
 * so "语义记忆" never renders with a workflow tone.
 */
export const MEMORY_TYPE_LABELS: Record<string, string> = {
  episodic: "情景记忆",
  semantic: "语义记忆",
  procedural: "程序记忆",
};

export function memoryTypeLabel(type: string): string {
  return MEMORY_TYPE_LABELS[type] ?? type;
}

/**
 * Task metadata that the API stores as enums but a person reads as words.
 *
 * `actionType` decides whether a task can cost money or touch the outside
 * world, so it is the last field that should render as `internal_read`.
 */
export const ACTION_TYPE_LABELS: Record<string, string> = {
  internal: "内部任务",
  internal_read: "只读内部数据",
  external: "外部调用",
  spend: "产生花费",
  publish: "对外发布",
  message: "发送消息",
  book: "代订",
};

export function actionTypeLabel(actionType: string): string {
  return ACTION_TYPE_LABELS[actionType] ?? actionType;
}

/** What the action touches. Paired with the action type, not a replacement. */
export const RESOURCE_LABELS: Record<string, string> = {
  task: "任务记录",
  calendar: "日历",
  ledger: "账本",
  web: "网页检索",
  plan: "计划",
};

export function resourceLabel(resource: string): string {
  return RESOURCE_LABELS[resource] ?? resource;
}

export const RISK_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

export function riskLabel(risk: string): string {
  return RISK_LABELS[risk] ?? risk;
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
  // skill
  draft: "草案",
  // memory
  superseded: "已被取代",
  conflicted: "自相矛盾",
  // audit log kind (the first segment of `audit_events.action`)
  // Every prefix that reaches an audit chip needs a word here: the filter row
  // on /review/audit prints raw segments for anything missing, so one gap turns
  // the row into "任务 12 · insight 3 · council 1".
  task: "任务",
  audit: "验收",
  checkin: "打卡",
  autonomy: "自治",
  agent: "Agent",
  insight: "洞察",
  grant: "授权",
  approval: "审批",
  council: "内阁",
  dissent: "异议",
  memory: "记忆",
  goal: "目标",
  chief: "Chief",
  apprentice: "学徒",
  workspace: "工作区",
  run: "运行",
  review: "复盘",
  // approval / insight / council
  pending: "待决定",
  expired: "已过期",
  proposed: "待采纳",
  applied: "已生效",
  rolled_back: "已回滚",
  open: "进行中",
  deliberating: "生成立场中",
  degraded: "立场生成失败",
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
  if (
    ["rejected", "failed", "retired", "rolled_back", "conflicted", "degraded"].includes(
      status,
    )
  )
    return "danger";
  if (["running", "assigned", "approved", "deliberating"].includes(status))
    return "blue";
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

/** Standing policies: what a previous approval now covers, and until when. */
export const GRANT_STATE_LABEL: Record<string, string> = {
  active: "自动执行中",
  revoked: "已撤销",
  expired: "已过期",
  exhausted: "次数用尽",
  base: "基础权限",
};

export const GRANT_STATE_TONE: Record<string, BadgeTone> = {
  active: "teal",
  revoked: "neutral",
  expired: "neutral",
  exhausted: "accent",
  base: "blue",
};

export function grantStateLabel(state: string): string {
  return GRANT_STATE_LABEL[state] ?? state;
}

export function grantStateTone(state: string): BadgeTone {
  return GRANT_STATE_TONE[state] ?? "neutral";
}

/**
 * Non-workflow states: deployment facts and provenance.
 *
 * These are deliberately *not* part of STATUS_LABELS. A workflow status says
 * where a task is; a capability state says what this deployment can actually
 * do right now — whether a connector is wired, whether the numbers on screen
 * are real or simulated. Mixing them made "未配置" render as a red failure.
 *
 * Rendered with text + icon, never colour alone.
 */
export const CAPABILITY_LABELS = {
  configured: "已配置",
  not_configured: "未配置",
  simulated: "模拟数据",
  unknown: "未知",
  unavailable: "暂不可用",
  degraded: "降级运行",
} as const;

export type CapabilityState = keyof typeof CAPABILITY_LABELS;

export function capabilityLabel(state: CapabilityState): string {
  return CAPABILITY_LABELS[state] ?? state;
}

/**
 * Tone rules, and the one that matters:
 *
 * `not_configured` and `unavailable` are `neutral`, NOT `danger`. Not wiring a
 * connector is a deployment fact, not a failure — nothing broke and there is
 * nothing to apologise for. Painting it red trains people to read the whole
 * page as broken and to ignore the red that does matter. Red is reserved for
 * states where something was attempted and went wrong.
 */
export function capabilityTone(state: CapabilityState): BadgeTone {
  if (state === "configured") return "teal";
  if (state === "degraded") return "accent";
  if (state === "simulated") return "violet";
  return "neutral";
}

/**
 * What the human is expected to do while a task sits in this state.
 *
 * A status label alone answers "what is happening"; this answers "do I need to
 * do anything". Without it every screen is a puzzle the user has to decode,
 * and `awaiting_approval` looks the same as `running` — one needs them, one
 * does not.
 */
export const STATUS_NEXT_ACTION: Record<string, string> = {
  queued: "等待调度，无需操作。",
  running: "Agent 正在执行，可留在本页等待。",
  awaiting_approval: "需要你批准后才会真正执行。",
  submitted: "已提交，等待 Auditor 验收。",
  auditing: "Auditor 正在核对验收标准。",
  accepted: "已通过验收，无需操作。",
  rejected: "被驳回，需要你查看原因并修改或重试。",
  failed: "执行失败，需要你判断是否重试。",
  done: "已完成。",
  cancelled: "已取消，如需继续请重新创建任务。",
};

/** `null` means there is no generic advice — the page owns this state. */
export function statusNextAction(status: string): string | null {
  return STATUS_NEXT_ACTION[status] ?? null;
}
