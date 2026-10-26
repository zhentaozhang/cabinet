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
  | { type: "manual"; note: string; required: boolean }
  /**
   * A criterion only a reader can settle ("解释为什么闭包能捕获变量").
   *
   * The deterministic pass in `domain/acceptance` cannot decide it and says so
   * (`undetermined`), exactly like `manual`. If a model is configured, the
   * judge pass fills in a verdict; without one the item stays undetermined
   * rather than silently passing or failing.
   */
  | { type: "judge"; value: string; required: boolean };

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

/** One judge ruling on one `judge` acceptance item. */
export type JudgeVerdict = {
  /** The criterion text this ruling answers — matched back by string. */
  criterion: string;
  pass: boolean;
  reason: string;
  /** The judge could not settle it (empty answer, unparseable reply). */
  undetermined?: boolean;
};

/**
 * A live override of one policy config leaf, written by an accepted insight.
 * `rolled_back` rows are kept: the audit trail must show the value was tried
 * and withdrawn, not that it never existed.
 */
export type PolicyOverrideStatus = "active" | "rolled_back";

/**
 * The change an insight proposes when accepted.
 *
 * `set_policy` is the only variant that changes runtime behaviour instead of
 * text or a single task: `key` is a dotted path into the policy config
 * (whitelisted in lib/policy/overrides.ts), and accepting it writes a
 * per-user override that `getPolicyConfigFor` folds into every later decision.
 */
export type ProposedChange =
  | { type: "reschedule"; taskId: string; from: string; to: string }
  | { type: "split_task"; taskId: string; minutes: number }
  | { type: "add_rule"; rule: string }
  | {
      type: "set_policy";
      key: string;
      value: number | boolean | string;
      reason: string;
    }
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

