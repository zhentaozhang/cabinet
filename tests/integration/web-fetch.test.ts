import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { agentGrants, agents, evidence, runs, steps, tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { runTask } from "@/server/services/engine";
import { getWeeklyMetrics } from "@/server/services/queries/metrics";
import { resetDb } from "../helpers/db";

const originalEnv = { ...process.env };

beforeEach(async () => {
  process.env = { ...originalEnv };
  delete process.env.BRAVE_API_KEY;
  delete process.env.TAVILY_API_KEY;
  vi.restoreAllMocks();
  await resetDb();
});

/**
 * Give the coach the one tool under test. Without a `web` grant the planner
 * refuses before it looks at the task, which is a different assertion.
 */
async function giveWebFetchOnly() {
  await db
    .update(agents)
    .set({ tools: ["web_fetch"] })
    .where(eq(agents.id, "ag_coach"));
  await db.insert(agentGrants).values({
    id: "agr_test_web",
    agentId: "ag_coach",
    resource: "web",
    scope: "read",
    config: {},
  });
}

/** The newest tool step of the newest run for a task. */
async function lastToolStep(taskId: string) {
  const rows = await db
    .select({ output: steps.output, tool: steps.tool })
    .from(steps)
    .innerJoin(runs, eq(steps.runId, runs.id))
    .where(and(eq(runs.taskId, taskId), eq(steps.type, "tool")))
    .orderBy(steps.createdAt);
  return rows.at(-1);
}

describe("web_fetch", () => {
  it("skips when the task names no URL, instead of running a search", async () => {
    await giveWebFetchOnly();

    // tsk_read's description has no link.
    const result = await runTask("tsk_read", DEMO_USER_ID);
    expect("runId" in result).toBe(true);

    const step = await lastToolStep("tsk_read");
    const output = step?.output as Record<string, unknown>;
    expect(output.tool).toBe("web_fetch");
    expect(output.status).toBe("skipped");
    expect(String(output.reason)).toContain("链接");
    expect(output.hits).toBe(0);

    const rows = await db.select().from(evidence).where(eq(evidence.taskId, "tsk_read"));
    expect(rows).toHaveLength(0);
  });

  it("never claims a fetch happened when the URL is not public", async () => {
    await giveWebFetchOnly();
    await db
      .update(tasks)
      .set({ description: "看这个 http://127.0.0.1:5432/ 然后总结" })
      .where(eq(tasks.id, "tsk_read"));

    await runTask("tsk_read", DEMO_USER_ID);

    const step = await lastToolStep("tsk_read");
    const output = step?.output as Record<string, unknown>;
    expect(output.status).toBe("invalid_response");
    expect(String(output.reason)).toContain("不是公网地址");

    const rows = await db.select().from(evidence).where(eq(evidence.taskId, "tsk_read"));
    expect(rows).toHaveLength(0);
  });
});

describe("retrieval accounting", () => {
  it("counts only calls that actually reached a provider", async () => {
    // A run with no connector configured records `not_connected`, which was
    // never billed, so the request counter has to stay at zero.
    await runTask("tsk_read", DEMO_USER_ID);
    const metrics = await getWeeklyMetrics(DEMO_USER_ID);
    expect(metrics.search.requests).toBe(0);
    expect(metrics.search.estimatedCents).toBe(0);
  });

  it("keeps retrieval out of the model-token total", async () => {
    const before = await getWeeklyMetrics(DEMO_USER_ID);
    await runTask("tsk_read", DEMO_USER_ID);
    const after = await getWeeklyMetrics(DEMO_USER_ID);
    // A demo-mode template draft spends nothing, and neither does a search that
    // never left the process: both totals stay where they were.
    expect(after.costCents).toBe(before.costCents);
    expect(after.search.requests).toBe(before.search.requests);
  });
});
