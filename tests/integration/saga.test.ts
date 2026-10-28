import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/llm", () => ({
  // run.ts imports this alongside generateArtifact to stamp live runs; a
  // factory that omits it would silently write null prompt versions.
  PROMPT_TEMPLATE_VERSION: 1,
  generateArtifact: async () => {
    throw new Error("simulated model failure");
  },
}));

import { db } from "@/lib/db";
import { artifacts, runs, tasks } from "@/lib/db/schema";
import { runTask } from "@/server/services/engine";
import { DEMO_USER_ID } from "@/lib/demo";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("run saga failure handling", () => {
  it("does not leave a submitted task without an artifact", async () => {
    await expect(runTask("tsk_read", DEMO_USER_ID)).rejects.toThrow(
      "simulated model failure",
    );

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_read"));
    expect(task.status).toBe("failed");

    const failedRuns = await db
      .select()
      .from(runs)
      .where(eq(runs.taskId, "tsk_read"));
    expect(failedRuns).toHaveLength(1);
    expect(failedRuns[0].status).toBe("failed");

    const createdArtifacts = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.taskId, "tsk_read"));
    expect(createdArtifacts).toHaveLength(0);
  });
});
