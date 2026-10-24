import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";
import type { AcceptanceItem } from "./types";
import { users } from "./core";

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
    /**
     * Standing policies created from one approval ("以后同类自动执行").
     *
     * A base grant says *what* an agent may touch; a standing policy says the
     * user already said yes to this class of action, once, on a date — so it
     * has an expiry, a money ceiling, a use budget and a revocation path. The
     * defaults below describe a plain permission grant with no such scope.
     */
    action: text("action").notNull().default("*"),
    label: text("label"),
    createdByApprovalId: text("created_by_approval_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    maxCents: integer("max_cents"),
    maxRuns: integer("max_runs"),
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("agent_grants_agent_idx").on(t.agentId),
    index("agent_grants_policy_idx").on(t.agentId, t.resource, t.action),
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
