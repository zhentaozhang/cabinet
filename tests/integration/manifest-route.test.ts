import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/tasks/[id]/manifest/route";
import { db } from "@/lib/db";
import { runs } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { UnauthorizedError } from "@/lib/domain/errors";
import { verifyManifest } from "@/lib/domain/manifest";
import { runTask } from "@/server/services/commands/tasks/run";
import { desc, eq } from "drizzle-orm";
import { resetDb } from "../helpers/db";

let currentUser = DEMO_USER_ID;
let unauthorized = false;

vi.mock("@/lib/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/context")>();
  return {
    ...actual,
    getApiUserId: async () => {
      if (unauthorized) throw new UnauthorizedError();
      return currentUser;
    },
  };
});

beforeEach(async () => {
  currentUser = DEMO_USER_ID;
  unauthorized = false;
  await resetDb();
});

function call(taskId: string, query = ""): Promise<Response> {
  return GET(new Request("http://localhost:3000/api/tasks/" + taskId + "/manifest" + query), {
    params: Promise.resolve({ id: taskId }),
  });
}

async function latestRunId(taskId: string): Promise<string> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return row.id;
}

describe("GET /api/tasks/[id]/manifest", () => {
  it("returns a downloadable manifest that verifies on its own", async () => {
    await runTask("tsk_read", DEMO_USER_ID);

    const response = await call("tsk_read");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-request-id")).toBeTruthy();

    const body = await response.text();
    expect(response.headers.get("content-disposition")).toContain(".manifest.json");

    const manifest = JSON.parse(body) as {
      runId: string;
      taskId: string;
      steps: unknown[];
      promptVersion: number;
    };
    expect(manifest.taskId).toBe("tsk_read");
    expect(manifest.steps.length).toBeGreaterThan(0);
    expect(manifest.promptVersion).toBeGreaterThan(0);

    // The prompt is what leaks the workspace, so the export must carry hashes
    // only. composeSystemPrompt opens with this exact phrase (src/lib/llm.ts).
    expect(body).not.toContain("你是");

    const result = verifyManifest(manifest);
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("skips the audit run when choosing the default run", async () => {
    await runTask("tsk_read", DEMO_USER_ID);
    const { auditTask } = await import("@/server/services/commands/tasks/audit");
    await auditTask("tsk_read", DEMO_USER_ID);
    const auditRunId = await latestRunId("tsk_read");

    const response = await call("tsk_read");
    const manifest = (await response.json()) as { runId: string };
    expect(manifest.runId).not.toBe(auditRunId);

    const pinned = await call("tsk_read", "?run=" + auditRunId);
    expect(pinned.status).toBe(200);
    expect(((await pinned.json()) as { runId: string }).runId).toBe(auditRunId);
  });

  it("answers 404 for another user's run", async () => {
    await runTask("tsk_read", DEMO_USER_ID);
    const runId = await latestRunId("tsk_read");

    currentUser = "usr_someone_else";
    const response = await call("tsk_read", "?run=" + runId);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("not_found");
  });

  it("answers 404 for a run that does not exist", async () => {
    const response = await call("tsk_read", "?run=run_missing");
    expect(response.status).toBe(404);
  });

  it("answers 401 when there is no session and auth is required", async () => {
    unauthorized = true;
    const response = await call("tsk_read");
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe("unauthorized");
  });
});
