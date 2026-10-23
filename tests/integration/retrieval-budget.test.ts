import { beforeEach, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { retrievalCalls, runs, steps, tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { runTask } from "@/lib/engine";
import { newId } from "@/lib/ids";
import { resetDb } from "../helpers/db";

const originalEnv = { ...process.env };

beforeEach(async () => {
  process.env = { ...originalEnv };
  process.env.BRAVE_API_KEY = "test-brave-key";
  process.env.SEARCH_COST_CENTS_PER_REQUEST = "5";
  delete process.env.RETRIEVAL_WEEKLY_BUDGET_CENTS;
  vi.restoreAllMocks();
  await resetDb();
});

/** `steps` hangs off a run, not a task, so look the run up first. */
async function lastToolStep(taskId: string) {
  const [run] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  if (!run) return undefined;

  const rows = await db
    .select()
    .from(steps)
    .where(eq(steps.runId, run.id))
    .orderBy(desc(steps.idx));
  return rows.find((row) => row.type === "tool");
}

describe("retrieval ceiling", () => {
  it("does not call the provider once this week's ceiling is spent", async () => {
    process.env.RETRIEVAL_WEEKLY_BUDGET_CENTS = "5";

    // Spend the ceiling first: one priced call this week.
    await db.insert(retrievalCalls).values({
      id: newId("rtc"),
      userId: DEMO_USER_ID,
      taskId: null,
      runId: null,
      tool: "web_search",
      provider: "brave",
      status: "ok",
      hits: 1,
      unitPriceCents: 5,
      chargedCents: 5,
      latencyMs: 30,
      createdAt: new Date(),
    });

    await db
      .update(tasks)
      .set({ status: "planned" })
      .where(eq(tasks.id, "tsk_research"));

    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ web: { results: [] } }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await runTask("tsk_research", DEMO_USER_ID);

    expect(fetchSpy).not.toHaveBeenCalled();

    const toolStep = await lastToolStep("tsk_research");
    const output = toolStep?.output as Record<string, unknown> | undefined;
    expect(output?.status).toBe("skipped");
    expect(String(output?.reason ?? "")).toContain("检索预算");

    vi.unstubAllGlobals();
  });

  it("still searches when the ceiling is not configured", async () => {
    await db
      .update(tasks)
      .set({ status: "planned" })
      .where(eq(tasks.id, "tsk_research"));

    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          web: { results: [{ url: "https://example.com/a", title: "A", description: "B" }] },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await runTask("tsk_research", DEMO_USER_ID);

    expect(fetchSpy).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
