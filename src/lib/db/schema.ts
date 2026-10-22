import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

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
  | { type: "section"; value: string; required: boolean }
  | { type: "manual"; note: string; required: boolean };

export type AcceptanceResult = {
  item: AcceptanceItem;
  passed: boolean;
  reason: string;
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

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    timezone: text("timezone").notNull().default("Asia/Shanghai"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull().references(() => users.id),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => users.id),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("accounts_user_idx").on(t.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

export const profiles = pgTable("profiles", {
  userId: text("user_id").primaryKey().references(() => users.id),
  constraints: jsonb("constraints").$type<Record<string, unknown>>().notNull(),
  preferences: jsonb("preferences")
    .$type<Record<string, unknown>>()
    .notNull(),
  energyPattern: jsonb("energy_pattern")
    .$type<Record<string, unknown>>()
    .notNull(),
  managementBudgetMin: integer("management_budget_min").notNull().default(3),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    role: text("role").notNull(),
    name: text("name").notNull(),
    title: text("title").notNull(),
    avatar: text("avatar").notNull(),
    charter: text("charter").notNull(),
    objective: text("objective").notNull(),
    model: text("model").notNull().default("auto"),
    status: text("status").notNull().default("active"),
    autonomyLevel: integer("autonomy_level").notNull().default(1),
    trustScore: real("trust_score").notNull().default(50),
    lifecycleStage: text("lifecycle_stage").notNull().default("active"),
    mentorId: text("mentor_id"),
    tools: jsonb("tools").$type<string[]>().notNull(),
    memoryScope: jsonb("memory_scope").$type<string[]>().notNull(),
    budgetCents: integer("budget_cents").notNull().default(0),
    spentCents: real("spent_cents").notNull().default(0),
    budgetPeriodStart: timestamp("budget_period_start", {
      withTimezone: true,
    }),
    policyJson: jsonb("policy_json").$type<Record<string, unknown>>(),
    successCount: integer("success_count").notNull().default(0),
    failCount: integer("fail_count").notNull().default(0),
    rejectStreak: integer("reject_streak").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (t) => [
    index("agents_user_idx").on(t.userId),
    index("agents_user_status_idx").on(t.userId, t.status),
    check("agents_autonomy_range", sql`${t.autonomyLevel} BETWEEN 0 AND 3`),
    check("agents_budget_non_negative", sql`${t.budgetCents} >= 0`),
  ],
);

export const agentGrants = pgTable(
  "agent_grants",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull().references(() => agents.id),
    resource: text("resource").notNull(),
    scope: text("scope").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index("agent_grants_agent_idx").on(t.agentId)],
);

export const goals = pgTable(
  "goals",
  {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  domain: text("domain").notNull(),
  title: text("title").notNull(),
  why: text("why").notNull(),
  target: text("target").notNull(),
  horizon: text("horizon").notNull(),
  status: text("status").notNull().default("active"),
  progress: real("progress").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  },
  (t) => [index("goals_user_status_idx").on(t.userId, t.status)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    goalId: text("goal_id").references(() => goals.id),
    parentId: text("parent_id"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    assigneeId: text("assignee_id").references(() => agents.id),
    auditorId: text("auditor_id").references(() => agents.id),
    status: text("status").notNull().default("planned"),
    priority: integer("priority").notNull().default(2),
    dueAt: timestamp("due_at", { withTimezone: true }),
    acceptanceCriteria: text("acceptance_criteria").notNull(),
    acceptanceChecklist: jsonb("acceptance_checklist")
      .$type<AcceptanceItem[]>(),
    acceptanceReport: jsonb("acceptance_report")
      .$type<AcceptanceResult[]>(),
    estimateMin: integer("estimate_min").notNull().default(25),
    actionType: text("action_type").notNull().default("internal"),
    resource: text("resource").notNull().default("task"),
    riskLevel: text("risk_level").notNull().default("low"),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    approvalThresholdCents: integer("approval_threshold_cents"),
    estimatedCostCents: integer("estimated_cost_cents").notNull().default(0),
    qualityGate: text("quality_gate"),
    template: text("template"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedAutonomyLevel: integer("accepted_autonomy_level"),
    createdBy: text("created_by").notNull().default("agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("tasks_status_idx").on(t.status),
    index("tasks_assignee_idx").on(t.assigneeId),
    index("tasks_user_status_idx").on(t.userId, t.status),
    index("tasks_user_due_idx").on(t.userId, t.dueAt),
    index("tasks_user_updated_idx").on(t.userId, t.updatedAt),
    index("tasks_user_accepted_idx").on(t.userId, t.acceptedAt),
    check(
      "tasks_assignee_not_auditor",
      sql`${t.assigneeId} IS NULL OR ${t.auditorId} IS NULL OR ${t.assigneeId} <> ${t.auditorId}`,
    ),
    check(
      "tasks_cost_non_negative",
      sql`${t.estimatedCostCents} >= 0`,
    ),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => tasks.id),
    agentId: text("agent_id").notNull().references(() => agents.id),
    status: text("status").notNull().default("queued"),
    mode: text("mode").notNull().default("demo"),
    sourceType: text("source_type").notNull().default("legacy_unknown"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // Telemetry only. The weekly budget ledger is the accounting authority.
    costCents: real("cost_cents").notNull().default(0),
    // Null means "usage unknown", which is not the same as a measured zero.
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    provider: text("provider"),
    model: text("model"),
    // One id per real provider call, unique across retries of the same task.
    providerAttemptId: text("provider_attempt_id"),
    costSource: text("cost_source"),
    error: text("error"),
    replayKey: text("replay_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("runs_task_idx").on(t.taskId),
    index("runs_agent_idx").on(t.agentId),
    index("runs_provider_attempt_idx").on(t.providerAttemptId),
    check(
      "runs_cost_source_check",
      sql`${t.costSource} IS NULL OR ${t.costSource} IN ('actual', 'estimated', 'unknown')`,
    ),
  ],
);

export const steps = pgTable(
  "steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    idx: integer("idx").notNull(),
    type: text("type").notNull(),
    tool: text("tool"),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    output: jsonb("output").$type<Record<string, unknown>>().notNull(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("steps_run_idx").on(t.runId)],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").references(() => runs.id),
    taskId: text("task_id").notNull().references(() => tasks.id),
    type: text("type").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    submittedBy: text("submitted_by").notNull().default("agent"),
    sourceType: text("source_type").notNull().default("legacy_unknown"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("artifacts_task_idx").on(t.taskId, t.createdAt),
    index("artifacts_run_idx").on(t.runId),
    index("artifacts_task_source_idx").on(
      t.taskId,
      t.submittedBy,
      t.createdAt,
    ),
    check(
      "artifacts_submitted_by_check",
      sql`${t.submittedBy} IN ('agent', 'user')`,
    ),
  ],
);

export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    agentId: text("agent_id").references(() => agents.id),
    type: text("type").notNull(),
    domain: text("domain").notNull(),
    content: text("content").notNull(),
    /** Stable key for a fact that can be superseded, e.g. schedule:tsk_1. */
    factKey: text("fact_key"),
    /** The fact's value at this point on the timeline. */
    value: text("value"),
    validFrom: timestamp("valid_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    supersededBy: text("superseded_by"),
    confidence: real("confidence").notNull().default(0.5),
    salience: real("salience").notNull().default(0.5),
    evidence: jsonb("evidence").$type<Evidence[]>().notNull(),
    sourceEventId: text("source_event_id"),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status").notNull().default("active"),
    sourceType: text("source_type").notNull().default("legacy_unknown"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("memories_user_idx").on(t.userId),
    index("memories_fact_idx").on(t.userId, t.factKey),
    uniqueIndex("memories_fact_active_unique")
      .on(t.userId, t.factKey)
      .where(sql`${t.validTo} IS NULL`),
  ],
);

export const insights = pgTable(
  "insights",
  {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  claim: text("claim").notNull(),
  rationale: text("rationale").notNull(),
  confidence: real("confidence").notNull().default(0.5),
  evidence: jsonb("evidence").$type<Evidence[]>().notNull(),
  proposedChange: jsonb("proposed_change")
    .$type<ProposedChange>()
    .notNull(),
  beforeState: jsonb("before_state").$type<Record<string, unknown> | null>(),
  afterState: jsonb("after_state").$type<Record<string, unknown> | null>(),
  status: text("status").notNull().default("proposed"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
},
  (t) => [
    index("insights_user_status_idx").on(t.userId, t.status),
    index("insights_user_created_idx").on(t.userId, t.createdAt),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  period: text("period").notNull(),
  type: text("type").notNull(),
  narrative: text("narrative").notNull(),
  metrics: jsonb("metrics").$type<Metrics>().notNull(),
  decisions: jsonb("decisions")
    .$type<Array<Record<string, unknown>>>()
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
},
  (t) => [
    index("reviews_user_type_idx").on(t.userId, t.type, t.createdAt),
    uniqueIndex("reviews_user_type_period_unique").on(
      t.userId,
      t.type,
      t.period,
    ),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  taskId: text("task_id").references(() => tasks.id),
  runId: text("run_id"),
  action: text("action").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("pending"),
  reason: text("reason"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
},
  (t) => [
    index("approvals_user_status_idx").on(t.userId, t.status),
    index("approvals_task_idx").on(t.taskId),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    userId: text("user_id").notNull().references(() => users.id),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    hash: text("hash").notNull(),
    prevHash: text("prev_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_user_idx").on(t.userId),
    index("audit_user_created_idx").on(t.userId, t.createdAt),
    index("audit_user_target_idx").on(t.userId, t.target),
    uniqueIndex("audit_seq_idx").on(t.seq),
  ],
);

export const skills = pgTable(
  "skills",
  {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  name: text("name").notNull(),
  version: integer("version").notNull().default(1),
  steps: jsonb("steps").$type<string[]>().notNull(),
  tools: jsonb("tools").$type<string[]>().notNull(),
  status: text("status").notNull().default("draft"),
  label: text("label").notNull().default("draft"),
  evalSet: jsonb("eval_set").$type<AcceptanceItem[]>(),
  successCount: integer("success_count").notNull().default(0),
  failCount: integer("fail_count").notNull().default(0),
  eval: jsonb("eval").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  },
  (t) => [index("skills_agent_idx").on(t.agentId)],
);

export const councils = pgTable(
  "councils",
  {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  topic: text("topic").notNull(),
  trigger: text("trigger").notNull(),
  status: text("status").notNull().default("open"),
  memo: text("memo").notNull(),
  matrix: jsonb("matrix").$type<CouncilMatrix>(),
  resolution: jsonb("resolution").$type<CouncilResolution>(),
  resolutionAppliedAt: timestamp("resolution_applied_at", {
    withTimezone: true,
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
},
  (t) => [index("councils_user_status_idx").on(t.userId, t.status)],
);

export const councilPositions = pgTable(
  "council_positions",
  {
  id: text("id").primaryKey(),
  councilId: text("council_id").notNull().references(() => councils.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
  stance: text("stance").notNull(),
  claim: text("claim").notNull(),
  evidence: jsonb("evidence").$type<Evidence[]>().notNull(),
  risk: text("risk").notNull(),
  recommendation: text("recommendation").notNull(),
  scores: jsonb("scores").$type<CouncilScore>(),
  isDissent: boolean("is_dissent").notNull().default(false),
  falsificationCondition: jsonb("falsification_condition").$type<FalsificationCondition>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  },
  (t) => [index("council_positions_council_idx").on(t.councilId)],
);

export const dissents = pgTable(
  "dissents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    councilId: text("council_id").notNull().references(() => councils.id),
    taskId: text("task_id").references(() => tasks.id),
    agentId: text("agent_id").notNull().references(() => agents.id),
    warning: text("warning").notNull(),
    condition: jsonb("condition").$type<FalsificationCondition>().notNull(),
    status: text("status").notNull().default("pending"),
    evidence: jsonb("evidence").$type<Evidence[]>().notNull(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("dissents_user_idx").on(t.userId),
    index("dissents_status_idx").on(t.status),
  ],
);

export const checkins = pgTable(
  "checkins",
  {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  date: text("date").notNull(),
  energy: integer("energy").notNull(),
  mood: integer("mood").notNull(),
  completed: jsonb("completed")
    .$type<Array<{ taskId: string; done: boolean }>>()
    .notNull(),
  note: text("note").notNull().default(""),
  studyMinutes: integer("study_minutes").notNull().default(0),
  recallScore: real("recall_score"),
  errorTags: jsonb("error_tags").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
},
  (t) => [
    uniqueIndex("checkins_user_date_idx").on(t.userId, t.date),
    check("checkins_study_minutes_non_negative", sql`${t.studyMinutes} >= 0`),
    check(
      "checkins_recall_score_range",
      sql`${t.recallScore} IS NULL OR (${t.recallScore} >= 0 AND ${t.recallScore} <= 1)`,
    ),
    check(
      "checkins_error_tags_array",
      sql`jsonb_typeof(${t.errorTags}) = 'array'`,
    ),
  ],
);

export const policyConfig = pgTable("policy_config", {
  key: text("key").primaryKey(),
  valueJson: jsonb("value_json").$type<unknown>().notNull(),
  description: text("description").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    key: text("key").notNull(),
    endpoint: text("endpoint").notNull(),
    requestHash: text("request_hash").notNull(),
    responseJson: jsonb("response_json").$type<Record<string, unknown>>(),
    statusCode: integer("status_code").notNull().default(200),
    status: text("status").notNull().default("completed"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("idempotency_user_key_idx").on(t.userId, t.key)],
);

export const userActions = pgTable(
  "user_actions",
  {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  action: text("action").notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  },
  (t) => [index("user_actions_user_created_idx").on(t.userId, t.createdAt)],
);

export const agentTemplates = pgTable("agent_templates", {
  role: text("role").primaryKey(),
  name: text("name").notNull(),
  title: text("title").notNull(),
  charter: text("charter").notNull(),
  objective: text("objective").notNull(),
  tools: jsonb("tools").$type<string[]>().notNull(),
  memoryScope: jsonb("memory_scope").$type<string[]>().notNull(),
  defaultAutonomy: integer("default_autonomy").notNull().default(1),
  budgetCents: integer("budget_cents").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rateLimits = pgTable(
  "rate_limits",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    action: text("action").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    uniqueIndex("rate_limit_unique_idx").on(
      t.userId,
      t.action,
      t.windowStart,
    ),
  ],
);

/**
 * Weekly budget ledger, one row per (Agent, user-local week).
 *
 * This table, not `runs.cost_cents` and not the legacy `agents.spent_cents`
 * columns, is the accounting authority for budget admission. `limitCents` is a
 * snapshot taken when the row is created so later policy edits do not rewrite
 * already-observed history.
 */
export const agentBudgetPeriods = pgTable(
  "agent_budget_periods",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    // The timezone that defines the local week boundaries of this period.
    timezone: text("timezone").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    limitCents: real("limit_cents").notNull(),
    reservedCents: real("reserved_cents").notNull().default(0),
    settledCents: real("settled_cents").notNull().default(0),
    unknownCents: real("unknown_cents").notNull().default(0),
    overrun: boolean("overrun").notNull().default(false),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_budget_periods_key").on(t.agentId, t.periodStart),
    check("agent_budget_periods_limit_check", sql`${t.limitCents} >= 0`),
    check("agent_budget_periods_reserved_check", sql`${t.reservedCents} >= 0`),
    check("agent_budget_periods_settled_check", sql`${t.settledCents} >= 0`),
    check("agent_budget_periods_unknown_check", sql`${t.unknownCents} >= 0`),
  ],
);

/**
 * One row per provider attempt that holds budget. `state = "reserved"` means
 * the allowance is still held; settlement moves it to `settled`, `released`,
 * or `unknown_charged`. The unique key is the run id (partial index, since a
 * hold may exist before its run row does).
 */
export const agentBudgetReservations = pgTable(
  "agent_budget_reservations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    periodId: text("period_id")
      .notNull()
      .references(() => agentBudgetPeriods.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    taskId: text("task_id").references(() => tasks.id),
    runId: text("run_id").references(() => runs.id),
    state: text("state").notNull().default("reserved"),
    amountCents: real("amount_cents").notNull(),
    settledCents: real("settled_cents").notNull().default(0),
    providerAttemptId: text("provider_attempt_id"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    // Partial unique index (`WHERE run_id IS NOT NULL`) is added in the
    // migration SQL; Drizzle's builder cannot express the predicate.
    index("agent_budget_reservations_period_idx").on(t.periodId),
    index("agent_budget_reservations_run_idx").on(t.runId),
    check(
      "agent_budget_reservations_state_check",
      sql`${t.state} IN ('reserved', 'settled', 'released', 'unknown_charged')`,
    ),
    check("agent_budget_reservations_amount_check", sql`${t.amountCents} >= 0`),
  ],
);

/**
 * Explicit training evidence: the user recorded that the apprentice watched one
 * specific mentor run. Nothing is inferred from historical runs, and demo, rule
 * or legacy rows can never be attested, so the exam gate counts real practice.
 */
export const apprenticeObservations = pgTable(
  "apprentice_observations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    apprenticeId: text("apprentice_id")
      .notNull()
      .references(() => agents.id),
    mentorId: text("mentor_id")
      .notNull()
      .references(() => agents.id),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    skillVersion: integer("skill_version").notNull(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    artifactId: text("artifact_id").references(() => artifacts.id),
    attestedByUserId: text("attested_by_user_id")
      .notNull()
      .references(() => users.id),
    attestedAt: timestamp("attested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    qualification: text("qualification").notNull().default("qualified"),
    reason: text("reason"),
  },
  (t) => [
    // One recording per (apprentice, skill version, mentor run): re-recording a
    // retried run can never inflate the evidence count.
    uniqueIndex("apprentice_observations_key").on(
      t.apprenticeId,
      t.skillId,
      t.skillVersion,
      t.runId,
    ),
    index("apprentice_observations_user_idx").on(t.userId),
    check(
      "apprentice_observations_qualification_check",
      sql`${t.qualification} IN ('qualified', 'disqualified')`,
    ),
  ],
);

/**
 * The evidence each exam attempt was graded against. Snapshots are immutable,
 * so retries reuse the same observations instead of consuming them, and an
 * auditor can always see which runs a pass was based on.
 */
export const apprenticeExamSnapshots = pgTable(
  "apprentice_exam_snapshots",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    apprenticeId: text("apprentice_id")
      .notNull()
      .references(() => agents.id),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    skillVersion: integer("skill_version").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    runId: text("run_id").references(() => runs.id),
    observationIds: jsonb("observation_ids").$type<string[]>().notNull().default([]),
    passed: boolean("passed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("apprentice_exam_snapshots_key").on(
      t.apprenticeId,
      t.skillId,
      t.skillVersion,
      t.attemptNo,
    ),
    index("apprentice_exam_snapshots_run_idx").on(t.runId),
  ],
);

/**
 * One row per externally retrieved source. Evidence is the only thing the
 * Auditor may count as a citation: prose that merely contains a URL proves
 * nothing, so `quote` is required and the row records who fetched it and when.
 */
export const evidence = pgTable(
  "evidence",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    taskId: text("task_id").references(() => tasks.id),
    runId: text("run_id").references(() => runs.id),
    kind: text("kind").notNull().default("web_page"),
    url: text("url").notNull(),
    title: text("title").notNull(),
    publisher: text("publisher"),
    /** Verbatim snippet from the provider; never generated by us. */
    quote: text("quote").notNull(),
    /** Provider that returned it, so a result stays attributable. */
    provider: text("provider").notNull(),
    contentHash: text("content_hash").notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("evidence_task_idx").on(t.taskId, t.createdAt),
    index("evidence_run_idx").on(t.runId),
    index("evidence_user_idx").on(t.userId),
  ],
);

export type EvidenceRow = typeof evidence.$inferSelect;
