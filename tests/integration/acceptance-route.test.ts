import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/tasks/[id]/acceptance/route";
import { DEMO_USER_ID } from "@/lib/demo";
import { resetDb } from "../helpers/db";

let currentUser = DEMO_USER_ID;

vi.mock("@/lib/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/context")>();
  return { ...actual, getApiUserId: async () => currentUser };
});

beforeEach(async () => {
  currentUser = DEMO_USER_ID;
  await resetDb();
});

function call(taskId: string, query = ""): Promise<Response> {
  return GET(
    new Request("http://localhost:3000/api/tasks/" + taskId + "/acceptance" + query),
    { params: Promise.resolve({ id: taskId }) },
  );
}

describe("GET /api/tasks/[id]/acceptance", () => {
  it("returns the contract the same way every time", async () => {
    const first = await call("tsk_read");
    expect(first.status).toBe(200);

    const payload = (await first.json()) as {
      ok: boolean;
      data: { contract: { taskId: string; checks: { id: string }[] }; markdown: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.contract.taskId).toBe("tsk_read");
    expect(payload.data.contract.checks.length).toBeGreaterThan(0);
    expect(payload.data.markdown).toContain("# 验收契约");

    const second = await call("tsk_read");
    expect(await second.text()).toBe(JSON.stringify(payload));
  });

  it("serves the Markdown form as a download", async () => {
    const response = await call("tsk_read", "?format=markdown");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("content-disposition")).toContain("tsk_read.acceptance.md");
    expect(await response.text()).toContain("## 逐条契约");
  });

  it("answers 404 for another user's task and for a missing task", async () => {
    currentUser = "usr_someone_else";
    expect((await call("tsk_read")).status).toBe(404);

    currentUser = DEMO_USER_ID;
    expect((await call("tsk_missing")).status).toBe(404);
  });
});
