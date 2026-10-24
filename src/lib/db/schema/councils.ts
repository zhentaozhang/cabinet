import { boolean, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { CouncilMatrix, CouncilResolution, CouncilScore, Evidence, FalsificationCondition } from "./types";
import { users } from "./core";
import { agents } from "./agents";
import { tasks } from "./tasks";

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
