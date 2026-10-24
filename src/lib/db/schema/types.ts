/**
 * JSON shapes stored in jsonb columns.
 *
 * Split out of schema.ts so the table modules can share them without
 * importing each other.
 */
export type Evidence = {
  label: string;
  ref?: string;
  quote?: string;
};

export type AcceptanceItem =
  | { type: "contains"; value: string; required: boolean }
  | { type: "min_words"; value: number; required: boolean }
  | { type: "min_sources"; value: number; required: boolean }
  | { type: "min_evidence"; value: number; required: boolean }
  | { type: "claims_table"; value: number; required: boolean }
  | { type: "section"; value: string; required: boolean }
  | { type: "manual"; note: string; required: boolean };

export type AcceptanceResult = {
  item: AcceptanceItem;
  passed: boolean;
  reason: string;
  /**
   * A rule that cannot decide on its own (a manual item, or an evidence rule
   * over someone's hand-written submission). `passed` is false because nothing
   * was verified — but it must not be read as a rejection.
   */
  undetermined?: boolean;
};

export type ProposedChange =
  | { type: "reschedule"; taskId: string; from: string; to: string }
  | { type: "split_task"; taskId: string; minutes: number }
  | { type: "add_rule"; rule: string }
  | { type: "none" };

export type Metrics = Record<string, number | string>;

export type CouncilScore = {
  feasibility: number;
  costEfficiency: number;
  evidenceQuality: number;
  robustness: number;
};

export type CouncilMatrix = {
  dimensions: CouncilScore;
  overall: number;
  support: number;
  oppose: number;
  neutral: number;
  consensus: "support" | "oppose" | "split";
  dissentAgentIds: string[];
};

export type CouncilResolution = {
  decision: "approve" | "reject" | "conditions";
  note: string;
  taskId: string | null;
  memoryId: string | null;
  dissents: Array<{
    agentId: string;
    claim: string;
    risk: string;
    recommendation: string;
  }>;
  decidedAt: string;
};

/**
 * Machine-checkable dissent condition. The weekly review evaluates it against
 * audit events and run costs; it is deliberately not free-form prose.
 */
export type FalsificationCondition = {
  metric:
    | "audit_reject_count"
    | "budget_spend_cents"
    | "task_failure_count"
    | "agent_paused";
  operator: ">=" | ">" | "==";
  threshold: number;
  windowDays: number;
};

