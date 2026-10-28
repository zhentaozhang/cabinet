import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const harness = vi.hoisted(() => ({
  impl: null as null | ((input: unknown) => Promise<unknown>),
}));

vi.mock("@/lib/llm", () => ({
  // run.ts imports this alongside generateArtifact to stamp live runs; a
  // factory that omits it would silently write null prompt versions.
  PROMPT_TEMPLATE_VERSION: 1,
  generateArtifact: (input: unknown) => harness.impl!(input),
}));

import { db } from "@/lib/db";
import { PROMPT_TEMPLATE_VERSION } from "@/lib/llm";
import { runs, tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { runTask } from "@/server/services/commands/tasks/run";
import { resetDb } from "../helpers/db";

// tsk_read is the seeded research task; the live path is taken because
// DEMO_MODE is unset in tests and a provider attempt is injected below.
const TASK_ID = "tsk_read";

async function runRows(taskId: string = TASK_ID) {
  return db.select().from(runs).where(eq(runs.taskId, taskId));
}

/** runTask's union result: the live path always returns a run id. */
async function runLive(): Promise<string> {
  const result = await runTask(TASK_ID, DEMO_USER_ID);
  if (!("runId" in result)) throw new Error("expected a live run");
  return result.runId;
}

beforeEach(async () => {
  await resetDb();
  harness.impl = null;
});

afterEach(() => {
  delete process.env.DEMO_MODE;
});

const liveCtx = { provider: "openai", model: "gpt-4.1-mini" };

describe("provider attempt identity", () => {
  it("persists provider, model, attempt id and measured usage on success", async () => {
    harness.impl = async () => ({
      status: "success",
      ...liveCtx,
      attemptId: "att_success",
      costSource: "actual",
      draft: { title: "标题", content: "正文", tokensIn: 111, tokensOut: 222 },
    });

    const runId = await runLive();
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));

    expect(run.mode).toBe("live");
    expect(run.status).toBe("succeeded");
    expect(run.provider).toBe("openai");
    expect(run.model).toBe("gpt-4.1-mini");
    expect(run.providerAttemptId).toBe("att_success");
    expect(run.tokensIn).toBe(111);
    expect(run.tokensOut).toBe(222);
    expect(run.costSource).toBe("actual");
    expect(run.promptVersion).toBe(PROMPT_TEMPLATE_VERSION);
  });

  it("keeps the attempt id but stores unknown usage as null, not zero, on timeout", async () => {
    harness.impl = async () => ({
      status: "timeout",
      ...liveCtx,
      attemptId: "att_timeout",
      costSource: "unknown",
    });

    await expect(runTask(TASK_ID, DEMO_USER_ID)).rejects.toThrow(
      "Model execution failed (timeout).",
    );

    const [run] = await runRows();
    expect(run.status).toBe("failed");
    expect(run.providerAttemptId).toBe("att_timeout");
    expect(run.costSource).toBe("unknown");
    expect(run.tokensIn).toBeNull();
    expect(run.tokensOut).toBeNull();
    // No draft was composed, so there is no template to name either.
    expect(run.promptVersion).toBeNull();
  });

  it("records no attempt at all when the provider was never configured", async () => {
    harness.impl = async () => ({ status: "not_configured", attemptId: null });

    await expect(runTask(TASK_ID, DEMO_USER_ID)).rejects.toThrow(
      "Model is not configured.",
    );

    const [run] = await runRows();
    expect(run.providerAttemptId).toBeNull();
    expect(run.tokensIn).toBeNull();
    expect(run.costSource).toBeNull();
  });

  it("gives each retry a distinct attempt id", async () => {
    harness.impl = async () => ({
      status: "provider_error",
      ...liveCtx,
      attemptId: "att_first",
      error: "ProviderError",
      costSource: "unknown",
    });
    await expect(runTask(TASK_ID, DEMO_USER_ID)).rejects.toThrow(
      "Model execution failed (provider_error).",
    );

    harness.impl = async () => ({
      status: "provider_error",
      ...liveCtx,
      attemptId: "att_second",
      error: "ProviderError",
      costSource: "unknown",
    });
    await expect(runTask(TASK_ID, DEMO_USER_ID)).rejects.toThrow(
      "Model execution failed (provider_error).",
    );

    const rows = await runRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.providerAttemptId).sort()).toEqual([
      "att_first",
      "att_second",
    ]);
  });

  it("never presents a demo draft as provider usage", async () => {
    process.env.DEMO_MODE = "true";
    harness.impl = async () => ({ status: "not_configured", attemptId: null });

    const runId = await runLive();
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));

    expect(run.mode).toBe("demo");
    expect(run.providerAttemptId).toBeNull();
    expect(run.tokensIn).toBeNull();
    expect(run.tokensOut).toBeNull();
    expect(run.costSource).not.toBe("actual");
    // The demo draft never went through composeSystemPrompt, so claiming a
    // prompt version here would describe a prompt nobody applied.
    expect(run.promptVersion).toBeNull();

    const [task] = await db.select().from(tasks).where(eq(tasks.id, TASK_ID));
    expect(task.status).toBe("submitted");
  });
});
