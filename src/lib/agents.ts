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

export const STATUS_LABELS: Record<string, string> = {
  active: "在岗",
  probation: "试用期",
  paused: "暂停",
  retired: "已退休",
  shadowing: "影子学习",
  drafting: "技能草案",
  examining: "考试中",
  planned: "待执行",
  assigned: "已指派",
  running: "执行中",
  submitted: "待验收",
  auditing: "验收中",
  accepted: "已通过",
  rejected: "已驳回",
  done: "完成",
  failed: "失败",
  pending: "待决定",
  approved: "已批准",
  proposed: "待采纳",
  applied: "已生效",
  rolled_back: "已回滚",
  open: "进行中",
  decided: "已决议",
};
