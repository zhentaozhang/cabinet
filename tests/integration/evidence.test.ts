import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { agents, evidence, runs, steps, tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { runTask } from "@/server/services/engine";
import { searchAndPersist } from "@/server/services/connectors/search";
import { resetDb } from "../helpers/db";

const originalEnv = { ...process.env };
const TASK_ID = "tsk_read";

beforeEach(async () => {
  process.env = { ...originalEnv };
  delete process.env.BRAVE_API_KEY;
  delete process.env.TAVILY_API_KEY;
  vi.restoreAllMocks();
  await resetDb();
});

/** A run row must exist before evidence can reference it. */
async function makeRun(): Promise<string> {
  const read = () =>
    db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.taskId, TASK_ID))
      .limit(1);

  const [existing] = await read();
  if (existing) return existing.id;

  await runTask(TASK_ID, DEMO_USER_ID);
  const [created] = await read();
  if (!created) throw new Error("runTask did not create a run row");
  return created.id;
}

describe("external evidence", () => {
  it("records not_connected when no connector is configured", async () => {
    const runId = await makeRun();
    const result = await searchAndPersist({
      userId: DEMO_USER_ID,
      taskId: TASK_ID,
      runId,
      query: "RAG 范式",
    });

    expect(result.status).toBe("not_connected");
    expect(result.evidence).toHaveLength(0);
    const rows = await db
      .select()
      .from(evidence)
      .where(eq(evidence.userId, DEMO_USER_ID));
    expect(rows).toHaveLength(0);
  });

  it("persists every citable hit with a stable content hash", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    const runId = await makeRun();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "RAG 综述",
                url: "https://example.com/rag",
                description: "检索增强生成把外部知识注入上下文。",
              },
              { title: "无摘要", url: "https://example.com/skip" },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const result = await searchAndPersist({
      userId: DEMO_USER_ID,
      taskId: TASK_ID,
      runId,
      query: "RAG 范式",
      fetchImpl,
    });

    expect(result.status).toBe("ok");
    expect(result.provider).toBe("brave");
    expect(result.evidence).toHaveLength(1);

    const rows = await db
      .select()
      .from(evidence)
      .where(
        and(eq(evidence.taskId, TASK_ID), eq(evidence.userId, DEMO_USER_ID)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      url: "https://example.com/rag",
      publisher: "example.com",
      provider: "brave",
      // A provider snippet, not the page itself.
      kind: "search_summary",
    });
    expect(rows[0].quote).toContain("检索增强生成");
    expect(rows[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].retrievedAt).toBeInstanceOf(Date);
  });

  it("surfaces a provider failure instead of inventing a result", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    const runId = await makeRun();
    const fetchImpl = vi.fn(
      async () => new Response("bad key", { status: 401 }),
    ) as unknown as typeof fetch;

    const result = await searchAndPersist({
      userId: DEMO_USER_ID,
      taskId: TASK_ID,
      runId,
      query: "RAG 范式",
      fetchImpl,
    });

    expect(result.status).toBe("unauthorized");
    expect(result.evidence).toHaveLength(0);
    const rows = await db
      .select()
      .from(evidence)
      .where(eq(evidence.userId, DEMO_USER_ID));
    expect(rows).toHaveLength(0);
  });

  it("records the tool decision on the run instead of claiming a call", async () => {
    await runTask(TASK_ID, DEMO_USER_ID);

    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.taskId, TASK_ID))
      .limit(1);
    const toolStep = await db
      .select()
      .from(steps)
      .where(and(eq(steps.runId, run.id), eq(steps.type, "tool")))
      .limit(1);

    expect(toolStep).toHaveLength(1);
    const output = toolStep[0].output as {
      status?: string;
      provider?: string | null;
      evidence?: unknown[];
    };
    expect(["unauthorized", "not_connected"]).toContain(output.status);
    expect(output.provider ?? null).toBeNull();
    expect(output.evidence ?? []).toEqual([]);
  });
});

describe("tool trace honesty", () => {
  /** The seeded research task, so a web tool is actually planned. */
  const RESEARCH_TASK = "tsk_research";

  /** The tool step of the run this task just produced (the seed has its own). */
  const lastToolStep = async () => {
    const [run] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.taskId, RESEARCH_TASK))
      .orderBy(desc(runs.createdAt))
      .limit(1);
    const rows = await db
      .select()
      .from(steps)
      .where(and(eq(steps.type, "tool"), eq(steps.runId, run.id)))
      .orderBy(desc(steps.idx));
    return rows[0];
  };

  it("never runs a keyword search in the name of web_fetch", async () => {
    // Only web_fetch is granted, so the planner must pick it. The task names no
    // URL, so a fetch has nothing to do — and a search would be a different
    // tool entirely. Either way no provider is contacted.
    await db
      .update(agents)
      .set({ tools: ["web_fetch"] })
      .where(eq(agents.id, "ag_research"));
    await db
      .update(tasks)
      .set({ status: "planned" })
      .where(eq(tasks.id, RESEARCH_TASK));

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await runTask(RESEARCH_TASK, DEMO_USER_ID);

    const step = await lastToolStep();
    const output = step.output as Record<string, unknown>;
    expect(output.tool).toBe("web_fetch");
    expect(output.status).toBe("skipped");
    expect(String(output.reason)).toContain("链接");
    expect(fetchSpy).not.toHaveBeenCalled();

    const rows = await db.select().from(evidence);
    expect(rows).toHaveLength(0);
  });

  it("records the query that was actually sent", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ web: { results: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await db
      .update(tasks)
      .set({ status: "planned" })
      .where(eq(tasks.id, RESEARCH_TASK));
    await runTask(RESEARCH_TASK, DEMO_USER_ID);

    const step = await lastToolStep();
    const input = step.input as Record<string, unknown>;
    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, RESEARCH_TASK));
    expect(String(input.query)).toBe(
      `${task.title} ${task.description}`.trim(),
    );
    vi.unstubAllGlobals();
  });
});
