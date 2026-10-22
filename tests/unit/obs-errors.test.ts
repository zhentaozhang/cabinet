import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  NotFoundError,
  PolicyDenied,
  RateLimitError,
  toErrorResponse,
} from "@/lib/domain/errors";

import { captureLog, eventsOf } from "../helpers/logs";

const LEVEL = process.env.OBS_LOG_LEVEL;

let sink: ReturnType<typeof captureLog>;

beforeEach(() => {
  sink = captureLog();
});

afterEach(() => {
  sink.restore();
  if (LEVEL === undefined) delete process.env.OBS_LOG_LEVEL;
  else process.env.OBS_LOG_LEVEL = LEVEL;
  vi.unstubAllEnvs();
});

describe("error surface", () => {
  test("an unexpected failure is logged in production too", () => {
    vi.stubEnv("NODE_ENV", "production");

    const { status, body } = toErrorResponse(new Error("connection reset"));

    expect(status).toBe(500);
    expect(body.code).toBe("internal_error");

    const record = eventsOf(sink.records(), "http.error")[0];
    expect(record).toMatchObject({
      level: "error",
      status: 500,
      fault: "server",
      errorMessage: "connection reset",
    });
  });

  test("business refusals are reported as information, not as incidents", () => {
    const { status } = toErrorResponse(new PolicyDenied("autonomy too low"));
    expect(status).toBe(403);

    expect(eventsOf(sink.records(), "http.rejected")[0]).toMatchObject({
      level: "info",
      code: "policy_denied",
      fault: "client",
    });
    expect(eventsOf(sink.records(), "http.error")).toHaveLength(0);
  });

  test("rate limiting is visible without being an error", () => {
    toErrorResponse(new RateLimitError());

    expect(eventsOf(sink.records(), "http.rejected")[0]).toMatchObject({
      level: "info",
      code: "rate_limited",
    });
    expect(eventsOf(sink.records(), "http.error")).toHaveLength(0);
  });

  test("a missing record stays out of the default log volume", () => {
    const { status } = toErrorResponse(new NotFoundError("Not found"));
    expect(status).toBe(404);

    // Debug-level rejections must not reach a default (info) collector, or the
    // pages that probe for optional rows would flood it.
    expect(eventsOf(sink.records(), "http.rejected")).toHaveLength(0);
  });
});
