/**
 * A run must be traceable as one object.
 *
 * The database rows are per-stage and the logs are per-event; neither answers
 * "which agent ran what, how many steps, how long". The span does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/llm", () => ({
  // run.ts imports this alongside generateArtifact to stamp live runs; a
  // factory that omits it would silently write null prompt versions.
  PROMPT_TEMPLATE_VERSION: 1,
  generateArtifact: () =>
    Promise.resolve({
      status: "success",
      attemptId: "att_trace",
      provider: "openai",
      model: "gpt-4.1-mini",
      costSource: "actual",
      draft: {
        title: "阅读 RAG 检索章节 · Mira",
        content: "## 笔记\n\n1. 先看例子\n2. 再看定义",
        tokensIn: 100,
        tokensOut: 50,
      },
    }),
}));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { steps } from "@/lib/db/schema";
import { setSpanSink, type FinishedSpan } from "@/lib/observability/tracing";
import { DEMO_USER_ID } from "@/lib/demo";
import { runTask } from "@/server/services/commands/tasks/run";
import { resetDb } from "../helpers/db";

async function traced(fn: () => Promise<unknown>): Promise<FinishedSpan[]> {
  const spans: FinishedSpan[] = [];
  setSpanSink((span) => spans.push(span));
  try {
    await fn();
  } finally {
    setSpanSink(null);
  }
  return spans;
}

describe("run tracing", () => {
  afterEach(() => setSpanSink(null));

  it("emits one run span carrying the run, agent and step count", async () => {
    await resetDb();
    const spans = await traced(() => runTask("tsk_read", DEMO_USER_ID));
    const root = spans.find((span) => span.name === "run.execute");
    expect(root).toBeDefined();
    expect(root!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root!.attributes["run.id"]).toMatch(/^run_/);
    expect(root!.attributes["agent.id"]).toBeTruthy();
    expect(Number(root!.attributes["run.steps"])).toBeGreaterThan(0);
    expect(root!.status.code).toBe(0);
    expect(root!.endTimeUnixNano >= root!.startTimeUnixNano).toBe(true);
  });

  it("opens one child span per persisted step", async () => {
    await resetDb();
    const spans = await traced(() => runTask("tsk_read", DEMO_USER_ID));
    const root = spans.find((span) => span.name === "run.execute")!;
    const runId = String(root.attributes["run.id"]);
    const rows = await db.select({ idx: steps.idx }).from(steps).where(eq(steps.runId, runId));
    const children = spans.filter((span) => span.parentSpanId === root.spanId);
    expect(children).toHaveLength(rows.length);
    expect(children.every((span) => typeof span.attributes["step.idx"] === "number")).toBe(true);
  });

  it("marks the span failed when the run never starts", async () => {
    await resetDb();
    const spans = await traced(async () => {
      await expect(runTask("tsk_missing", DEMO_USER_ID)).rejects.toThrow("Task not found");
    });
    const root = spans.find((span) => span.name === "run.execute");
    expect(root).toBeDefined();
    expect(root!.status.code).toBe(2);
    expect(root!.status.message).toContain("Task not found");
  });
});
