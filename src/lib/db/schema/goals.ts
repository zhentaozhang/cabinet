import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./core";

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

export const checkins = pgTable(
  "checkins",
  {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
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
