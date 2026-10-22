import {
  bigserial,
  boolean,
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

export type ProposedChange =
  | { type: "reschedule"; taskId: string; from: string; to: string }
  | { type: "split_task"; taskId: string; minutes: number }
  | { type: "add_rule"; rule: string }
  | { type: "none" };

export type Metrics = Record<string, number | string>;

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Asia/Shanghai"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const profiles = pgTable("profiles", {
  userId: text("user_id").primaryKey(),
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
    userId: text("user_id").notNull(),
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
  (t) => [index("agents_user_idx").on(t.userId)],
);

export const agentGrants = pgTable("agent_grants", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  resource: text("resource").notNull(),
  scope: text("scope").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull(),
});

export const goals = pgTable("goals", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
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
});

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    goalId: text("goal_id"),
    parentId: text("parent_id"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    assigneeId: text("assignee_id"),
    auditorId: text("auditor_id"),
    status: text("status").notNull().default("planned"),
    priority: integer("priority").notNull().default(2),
    dueAt: timestamp("due_at", { withTimezone: true }),
    acceptanceCriteria: text("acceptance_criteria").notNull(),
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
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    agentId: text("agent_id").notNull(),
    status: text("status").notNull().default("queued"),
    mode: text("mode").notNull().default("demo"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    costCents: real("cost_cents").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    error: text("error"),
    replayKey: text("replay_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("runs_task_idx").on(t.taskId)],
);

export const steps = pgTable(
  "steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
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

export const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  taskId: text("task_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    agentId: text("agent_id"),
    type: text("type").notNull(),
    domain: text("domain").notNull(),
    content: text("content").notNull(),
    confidence: real("confidence").notNull().default(0.5),
    salience: real("salience").notNull().default(0.5),
    evidence: jsonb("evidence").$type<Evidence[]>().notNull(),
    sourceEventId: text("source_event_id"),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("memories_user_idx").on(t.userId)],
);

export const insights = pgTable("insights", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
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
});

export const reviews = pgTable("reviews", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
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
});

export const approvals = pgTable("approvals", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  taskId: text("task_id"),
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
});

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    userId: text("user_id").notNull(),
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
  (t) => [index("audit_user_idx").on(t.userId)],
);

export const skills = pgTable("skills", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  name: text("name").notNull(),
  version: integer("version").notNull().default(1),
  steps: jsonb("steps").$type<string[]>().notNull(),
  tools: jsonb("tools").$type<string[]>().notNull(),
  status: text("status").notNull().default("draft"),
  successCount: integer("success_count").notNull().default(0),
  failCount: integer("fail_count").notNull().default(0),
  eval: jsonb("eval").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const councils = pgTable("councils", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  topic: text("topic").notNull(),
  trigger: text("trigger").notNull(),
  status: text("status").notNull().default("open"),
  memo: text("memo").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const councilPositions = pgTable("council_positions", {
  id: text("id").primaryKey(),
  councilId: text("council_id").notNull(),
  agentId: text("agent_id").notNull(),
  stance: text("stance").notNull(),
  claim: text("claim").notNull(),
  evidence: jsonb("evidence").$type<Evidence[]>().notNull(),
  risk: text("risk").notNull(),
  recommendation: text("recommendation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const checkins = pgTable("checkins", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  date: text("date").notNull(),
  energy: integer("energy").notNull(),
  mood: integer("mood").notNull(),
  completed: jsonb("completed")
    .$type<Array<{ taskId: string; done: boolean }>>()
    .notNull(),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    endpoint: text("endpoint").notNull(),
    requestHash: text("request_hash").notNull(),
    responseJson: jsonb("response_json").$type<Record<string, unknown>>(),
    statusCode: integer("status_code").notNull().default(200),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("idempotency_user_key_idx").on(t.userId, t.key)],
);

export const userActions = pgTable("user_actions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  action: text("action").notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
