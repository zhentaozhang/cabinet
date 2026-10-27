import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/tasks/[id]/policy-preview/route";
import { DEMO_USER_ID } from "@/lib/demo";
import { UnauthorizedError } from "@/lib/domain/errors";
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

function call(taskId: string): Promise<Response> {
  return GET(
    new Request("http://localhost:3000/api/tasks/" + taskId + "/policy-preview"),
    { params: Promise.resolve({ id: taskId }) },
  );
}

describe("GET /api/tasks/[id]/policy-preview", () => {
  it("返回与 decideRun 同源的四段结论", async () => {
    const response = await call("tsk_read");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBeTruthy();

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(["allow", "suggest", "require_approval", "deny"]).toContain(
      body.data.effect,
    );
    expect(typeof body.data.rule).toBe("string");
    expect(body.data.rule.length).toBeGreaterThan(0);
    expect(typeof body.data.reason).toBe("string");
    expect(body.data.reason.length).toBeGreaterThan(0);
    expect(Array.isArray(body.data.missing)).toBe(true);
    // 放行时不该再有「还缺什么」，否则面板会自相矛盾。
    expect(body.data.missing.length === 0).toBe(body.data.effect === "allow");
  });

  it("别人的任务与不存在的任务回同一个 404", async () => {
    currentUser = "usr_someone_else";
    const foreign = await call("tsk_read");
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).code).toBe("not_found");

    currentUser = DEMO_USER_ID;
    const missing = await call("tsk_does_not_exist");
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe("not_found");
  });

  it("未登录时 401，不泄露任务是否存在", async () => {
    unauthorized = true;
    const response = await call("tsk_read");
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("unauthorized");
  });

  it("同一份数据连调两次结论一致（预演必须是只读的）", async () => {
    const first = await (await call("tsk_read")).json();
    const second = await (await call("tsk_read")).json();
    expect(second.data).toEqual(first.data);
  });
});
