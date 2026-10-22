import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { log, serialiseError } from "@/lib/obs/logger";

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
});

describe("structured logging", () => {
  test("writes exactly one JSON object per line", () => {
    log("info", "probe", { count: 2 });

    const lines = sink.lines().filter((line) => line.startsWith("{"));
    expect(lines).toHaveLength(1);

    const record = eventsOf(sink.records(), "probe")[0];
    expect(record).toMatchObject({ level: "info", event: "probe", count: 2 });
    expect(typeof record?.ts).toBe("string");
  });

  test("respects OBS_LOG_LEVEL", () => {
    process.env.OBS_LOG_LEVEL = "warn";

    log("debug", "suppressed_debug");
    log("info", "suppressed_info");
    log("warn", "kept_warn");

    const events = sink.records().map((record) => record.event);
    expect(events).toContain("kept_warn");
    expect(events).not.toContain("suppressed_info");
    expect(events).not.toContain("suppressed_debug");
  });

  test("redacts user content but keeps measurement fields", () => {
    log("info", "artifact", {
      content: "the user's private draft",
      title: "Q3 pricing plan",
      prompt: "system prompt",
      tokensIn: 120,
      tokensOut: 340,
      durMs: 88,
      route: "/api/tasks",
    });

    const record = eventsOf(sink.records(), "artifact")[0];
    expect(record?.content).toBe("[redacted]");
    expect(record?.title).toBe("[redacted]");
    expect(record?.prompt).toBe("[redacted]");
    expect(record?.tokensIn).toBe(120);
    expect(record?.tokensOut).toBe(340);
    expect(record?.durMs).toBe(88);
    expect(record?.route).toBe("/api/tasks");
    expect(JSON.stringify(record)).not.toContain("private draft");
  });

  test("never throws, whatever it is handed", () => {
    const circular: Record<string, unknown> = { label: "loop" };
    circular.self = circular;

    expect(() => {
      log("info", "hostile", {
        circular,
        big: BigInt(10),
        fn: () => undefined,
        nothing: undefined,
        nan: Number.NaN,
      });
    }).not.toThrow();

    const record = eventsOf(sink.records(), "hostile")[0];
    expect(record?.big).toBe("10");
    expect(record?.fn).toBeUndefined();
    // The cycle is cut by depth, not walked forever.
    expect(JSON.stringify(record?.circular)).toContain("[depth]");
    expect(JSON.stringify(record).length).toBeLessThan(2_000);
  });

  test("bounds long strings and deep structures", () => {
    log("info", "bounded", {
      detail: "x".repeat(2000),
      nested: { a: { b: { c: { d: { e: "too deep" } } } } },
    });

    const record = eventsOf(sink.records(), "bounded")[0];
    expect(String(record?.detail).length).toBeLessThanOrEqual(401);
    expect(JSON.stringify(record)).not.toContain("too deep");
  });

  test("serialiseError keeps the useful parts and drops the rest", () => {
    const error = new Error("boom");
    error.stack = ["Error: boom", "  at a", "  at b", "  at c", "  at d", "  at e"].join("\n");

    const fields = serialiseError(error);
    expect(fields.errorName).toBe("Error");
    expect(fields.errorMessage).toBe("boom");
    expect(String(fields.stack).split("\n")).toHaveLength(4);

    expect(serialiseError("not an error")).toMatchObject({
      errorMessage: "not an error",
    });
  });
});
