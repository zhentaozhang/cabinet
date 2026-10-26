import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agentBudgetReservations,
  agentGrants,
  agents,
  apprenticeExamSnapshots,
  apprenticeObservations,
  approvals,
  artifacts,
  auditEvents,
  checkins,
  councilPositions,
  councils,
  dissents,
  evidence,
  goals,
  insights,
  learningAttempts,
  learningMastery,
  learningTopics,
  memories,
  outbox,
  policyOverrides,
  profiles,
  retrievalCalls,
  reviews,
  runs,
  skills,
  steps,
  tasks,
  users,
} from "@/lib/db/schema";

/** Rows per line. Small enough that one line never dominates the response. */
const CHUNK = 500;

type Fetcher = (limit: number, offset: number) => Promise<unknown[]>;

/**
 * Export one account as newline-delimited JSON, one table chunk per line.
 *
 * Why NDJSON instead of a single JSON document: the whole export used to be
 * built in memory and stringified at once, so an account with a long run
 * history had to fit twice in RAM. Streaming also lets a client stop reading.
 *
 * Every table is read with the same `cutoff` in the header; rows written after
 * the export started are simply not included. This is not a database snapshot:
 * a row updated mid-export may appear in its newer state.
 */
export async function* exportAccountNdjson(
  userId: string,
): AsyncGenerator<string> {
  const cutoff = new Date();
  yield line({
    kind: "meta",
    format: "cabinet-ndjson/1",
    exportedAt: cutoff.toISOString(),
    note: "每行一个 JSON 对象；同一张表可能分多行（rows 数组）返回。",
  });

  const agentIds = (
    await db.select({ id: agents.id }).from(agents).where(eq(agents.userId, userId))
  ).map((row) => row.id);
  const taskIds = (
    await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.userId, userId))
  ).map((row) => row.id);
  const councilIds = (
    await db.select({ id: councils.id }).from(councils).where(eq(councils.userId, userId))
  ).map((row) => row.id);
  const runIds = agentIds.length
    ? (
        await db
          .select({ id: runs.id })
          .from(runs)
          .where(inArray(runs.agentId, agentIds))
      ).map((row) => row.id)
    : [];

  const tables: Array<{ name: string; rows: Fetcher }> = [
    {
      name: "users",
      rows: (limit, offset) =>
        db.select().from(users).where(eq(users.id, userId)).limit(limit).offset(offset),
    },
    {
      name: "profiles",
      rows: (limit, offset) =>
        db
          .select()
          .from(profiles)
          .where(eq(profiles.userId, userId))
          .limit(limit)
          .offset(offset),
    },
    {
      name: "agents",
      rows: (limit, offset) =>
        db
          .select()
          .from(agents)
          .where(eq(agents.userId, userId))
          .orderBy(agents.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "goals",
      rows: (limit, offset) =>
        db
          .select()
          .from(goals)
          .where(eq(goals.userId, userId))
          .orderBy(goals.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "tasks",
      rows: (limit, offset) =>
        db
          .select()
          .from(tasks)
          .where(eq(tasks.userId, userId))
          .orderBy(tasks.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "runs",
      rows: (limit, offset) =>
        agentIds.length
          ? db
              .select()
              .from(runs)
              .where(inArray(runs.agentId, agentIds))
              .orderBy(runs.id)
              .limit(limit)
              .offset(offset)
          : Promise.resolve([]),
    },
    {
      name: "steps",
      rows: (limit, offset) =>
        runIds.length
          ? db
              .select()
              .from(steps)
              .where(inArray(steps.runId, runIds))
              .orderBy(steps.id)
              .limit(limit)
              .offset(offset)
          : Promise.resolve([]),
    },
    {
      name: "artifacts",
      rows: (limit, offset) =>
        taskIds.length
          ? db
              .select()
              .from(artifacts)
              .where(inArray(artifacts.taskId, taskIds))
              .orderBy(artifacts.id)
              .limit(limit)
              .offset(offset)
          : Promise.resolve([]),
    },
    {
      name: "skills",
      rows: (limit, offset) =>
        agentIds.length
          ? db
              .select()
              .from(skills)
              .where(inArray(skills.agentId, agentIds))
              .orderBy(skills.id)
              .limit(limit)
              .offset(offset)
          : Promise.resolve([]),
    },
    {
      name: "memories",
      rows: (limit, offset) =>
        db
          .select()
          .from(memories)
          .where(eq(memories.userId, userId))
          .orderBy(memories.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "evidence",
      rows: (limit, offset) =>
        db
          .select()
          .from(evidence)
          .where(eq(evidence.userId, userId))
          .orderBy(evidence.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "retrievalCalls",
      rows: (limit, offset) =>
        db
          .select()
          .from(retrievalCalls)
          .where(eq(retrievalCalls.userId, userId))
          .orderBy(retrievalCalls.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "insights",
      rows: (limit, offset) =>
        db
          .select()
          .from(insights)
          .where(eq(insights.userId, userId))
          .orderBy(insights.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "reviews",
      rows: (limit, offset) =>
        db
          .select()
          .from(reviews)
          .where(eq(reviews.userId, userId))
          .orderBy(reviews.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "approvals",
      rows: (limit, offset) =>
        db
          .select()
          .from(approvals)
          .where(eq(approvals.userId, userId))
          .orderBy(approvals.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "councils",
      rows: (limit, offset) =>
        db
          .select()
          .from(councils)
          .where(eq(councils.userId, userId))
          .orderBy(councils.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "councilPositions",
      rows: (limit, offset) =>
        councilIds.length
          ? db
              .select()
              .from(councilPositions)
              .where(inArray(councilPositions.councilId, councilIds))
              .orderBy(councilPositions.id)
              .limit(limit)
              .offset(offset)
          : Promise.resolve([]),
    },
    {
      name: "checkins",
      rows: (limit, offset) =>
        db
          .select()
          .from(checkins)
          .where(eq(checkins.userId, userId))
          .orderBy(checkins.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "dissents",
      rows: (limit, offset) =>
        db
          .select()
          .from(dissents)
          .where(eq(dissents.userId, userId))
          .orderBy(dissents.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "auditEvents",
      rows: (limit, offset) =>
        db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.userId, userId))
          .orderBy(auditEvents.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "agentGrants",
      rows: (limit, offset) =>
        agentIds.length
          ? db
              .select()
              .from(agentGrants)
              .where(inArray(agentGrants.agentId, agentIds))
              .orderBy(agentGrants.id)
              .limit(limit)
              .offset(offset)
          : Promise.resolve([]),
    },
    {
      name: "agentBudgetPeriods",
      rows: (limit, offset) =>
        db
          .select()
          .from(agentBudgetPeriods)
          .where(eq(agentBudgetPeriods.userId, userId))
          .orderBy(agentBudgetPeriods.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "agentBudgetReservations",
      rows: (limit, offset) =>
        db
          .select()
          .from(agentBudgetReservations)
          .where(eq(agentBudgetReservations.userId, userId))
          .orderBy(agentBudgetReservations.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "apprenticeObservations",
      rows: (limit, offset) =>
        db
          .select()
          .from(apprenticeObservations)
          .where(eq(apprenticeObservations.userId, userId))
          .orderBy(apprenticeObservations.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "apprenticeExamSnapshots",
      rows: (limit, offset) =>
        db
          .select()
          .from(apprenticeExamSnapshots)
          .where(eq(apprenticeExamSnapshots.userId, userId))
          .orderBy(apprenticeExamSnapshots.id)
          .limit(limit)
          .offset(offset),
    },
    // 学习历史与策略覆盖同样是用户自己的数据：/api/account 的删除清单里有
    // 这四张表，导出侧也必须一致，否则"能删不能带走"。
    {
      name: "learningTopics",
      rows: (limit, offset) =>
        db
          .select()
          .from(learningTopics)
          .where(eq(learningTopics.userId, userId))
          .orderBy(learningTopics.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "learningMastery",
      rows: (limit, offset) =>
        db
          .select()
          .from(learningMastery)
          .where(eq(learningMastery.userId, userId))
          .orderBy(learningMastery.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "learningAttempts",
      rows: (limit, offset) =>
        db
          .select()
          .from(learningAttempts)
          .where(eq(learningAttempts.userId, userId))
          .orderBy(learningAttempts.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "policyOverrides",
      rows: (limit, offset) =>
        db
          .select()
          .from(policyOverrides)
          .where(eq(policyOverrides.userId, userId))
          .orderBy(policyOverrides.id)
          .limit(limit)
          .offset(offset),
    },
    {
      name: "outbox",
      rows: (limit, offset) =>
        db
          .select()
          .from(outbox)
          .where(eq(outbox.userId, userId))
          .orderBy(outbox.id)
          .limit(limit)
          .offset(offset),
    },
  ];

  for (const table of tables) {
    let offset = 0;
    for (;;) {
      const rows = await table.rows(CHUNK, offset);
      if (rows.length === 0) break;
      yield line({ kind: "rows", table: table.name, rows });
      offset += rows.length;
      if (rows.length < CHUNK) break;
    }
  }

  yield line({ kind: "end", tables: tables.length });
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
