import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { artifacts, runs, tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { runTask } from "@/lib/engine";
import { resetDb } from "../helpers/db";

const originalDemoMode = process.env.DEMO_MODE;
const originalKey = process.env.OPENAI_API_KEY;

beforeEach(async () => {
  await resetDb();
  process.env.DEMO_MODE = "false";
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (originalDemoMode === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = originalDemoMode;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
});

describe("real run failure semantics", () => {
  it("does not replace a missing model with a template artifact", async () => {
    await expect(runTask("tsk_read", DEMO_USER_ID)).rejects.toThrow(
      /Model is not configured/,
    );

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_read"));
    expect(task.status).toBe("failed");

    const taskRuns = await db
      .select()
      .from(runs)
      .where(eq(runs.taskId, "tsk_read"));
    expect(taskRuns).toHaveLength(1);
    expect(taskRuns[0].status).toBe("failed");
    expect(taskRuns[0].mode).toBe("live");

    const taskArtifacts = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.taskId, "tsk_read"));
    expect(taskArtifacts).toHaveLength(0);
  });
});
