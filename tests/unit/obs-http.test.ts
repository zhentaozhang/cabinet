import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  headers: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(Object.fromEntries(state.headers)),
}));

// `after()` needs a request scope; in a unit test we simply run the callback.
vi.mock("next/server", () => ({
  after: (task: () => void) => {
    task();
  },
}));

import { bindUser } from "@/lib/obs/context";
import { runHttpRequest } from "@/lib/obs/http";

import { captureLog, eventsOf } from "../helpers/logs";

const LEVEL = process.env.OBS_LOG_LEVEL;

let sink: ReturnType<typeof captureLog>;

beforeEach(() => {
  sink = captureLog();
  state.headers.clear();
});

afterEach(() => {
  sink.restore();
  if (LEVEL === undefined) delete process.env.OBS_LOG_LEVEL;
  else process.env.OBS_LOG_LEVEL = LEVEL;
});

function withIncoming(requestId: string, path: string, method = "GET") {
  state.headers.set("x-request-id", requestId);
  state.headers.set("x-request-path", path);
  state.headers.set("x-request-method", method);
}

describe("request observation wrapper", () => {
  test("inherits the proxy's identifier and returns it to the caller", async () => {
    withIncoming("r_0123456789abcdef", "/api/tasks/tsk_ab12cd34/run", "POST");

    const response = await runHttpRequest("mutation", async () =>
      Response.json({ ok: true }),
    );

    expect(response.headers.get("x-request-id")).toBe("r_0123456789abcdef");
    expect(eventsOf(sink.records(), "http.request")[0]).toMatchObject({
      requestId: "r_0123456789abcdef",
      method: "POST",
      route: "/api/tasks/:id/run",
      kind: "mutation",
      status: 200,
      level: "info",
    });
  });

  test("mints an identifier when the proxy did not run", async () => {
    const response = await runHttpRequest("query", async () =>
      Response.json({ ok: true }),
    );

    const record = eventsOf(sink.records(), "http.request")[0];
    expect(response.headers.get("x-request-id")).toMatch(/^r_[0-9a-f]{16}$/);
    expect(record?.requestId).toBe(response.headers.get("x-request-id"));
    expect(record?.route).toBe("/");
  });

  test("emits exactly one access line per request", async () => {
    withIncoming("r_0123456789abcdef", "/api/today");

    await runHttpRequest("query", async () => Response.json({ ok: true }));
    await runHttpRequest("query", async () => Response.json({ ok: true }));

    expect(eventsOf(sink.records(), "http.request")).toHaveLength(2);
  });

  test("grades the line by status and carries the pseudonymous user", async () => {
    withIncoming("r_0123456789abcdef", "/api/tasks");

    await runHttpRequest("query", async () => {
      bindUser("usr_zhen");
      return Response.json({ ok: false }, { status: 404 });
    });
    await runHttpRequest("query", async () =>
      Response.json({ ok: false }, { status: 500 }),
    );

    const [notFound, failure] = eventsOf(sink.records(), "http.request");
    expect(notFound).toMatchObject({ status: 404, level: "warn" });
    expect(String(notFound?.user)).toMatch(/^u_[0-9a-f]{8}$/);
    expect(notFound?.user).not.toBe("usr_zhen");
    expect(failure).toMatchObject({ status: 500, level: "error" });
  });

  test("reports a pipeline that throws instead of returning", async () => {
    withIncoming("r_0123456789abcdef", "/api/today");

    await expect(
      runHttpRequest("query", async () => {
        throw new Error("pipeline bug");
      }),
    ).rejects.toThrow("pipeline bug");

    const unhandled = eventsOf(sink.records(), "http.unhandled")[0];
    expect(unhandled).toMatchObject({
      level: "error",
      requestId: "r_0123456789abcdef",
      errorMessage: "pipeline bug",
    });

    // The failed request still gets a terminal access line.
    expect(eventsOf(sink.records(), "http.request")[0]).toMatchObject({
      status: 500,
      level: "error",
    });
  });
});
