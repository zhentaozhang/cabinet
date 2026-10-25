import { afterEach, describe, expect, it } from "vitest";
import {
  currentSpan,
  setSpanSink,
  startSpan,
  tracingEnabled,
  withSpan,
  type FinishedSpan,
} from "@/lib/observability/tracing";

function collect(): { spans: FinishedSpan[]; restore: () => void } {
  const spans: FinishedSpan[] = [];
  setSpanSink((span) => spans.push(span));
  return { spans, restore: () => setSpanSink(null) };
}

describe("tracing", () => {
  afterEach(() => setSpanSink(null));

  it("is off unless an OTLP endpoint is configured", () => {
    expect(tracingEnabled()).toBe(false);
  });

  it("mints hex ids in the widths OTLP requires", () => {
    const span = startSpan({ name: "run.execute" });
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.parentSpanId).toBeNull();
    span.end();
  });

  it("records a monotonic end time even with no exporter", () => {
    const { spans, restore } = collect();
    const span = startSpan({ name: "run.execute" });
    span.end();
    restore();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.endTimeUnixNano >= spans[0]!.startTimeUnixNano).toBe(true);
    expect(typeof spans[0]!.endTimeUnixNano).toBe("bigint");
  });

  it("links a child to its parent and inherits the trace", async () => {
    const { spans, restore } = collect();
    await withSpan({ name: "run.execute" }, async (parent) => {
      expect(currentSpan()?.spanId).toBe(parent.spanId);
      const child = startSpan({ name: "context" });
      expect(child.traceId).toBe(parent.traceId);
      expect(child.parentSpanId).toBe(parent.spanId);
      child.end();
    });
    restore();
    const root = spans.find((span) => span.name === "run.execute")!;
    const child = spans.find((span) => span.name === "context")!;
    expect(child.parentSpanId).toBe(root.spanId);
  });

  it("drops attributes that would leak secrets or content", () => {
    const { spans, restore } = collect();
    const span = startSpan({ name: "llm.call" });
    span.setAttribute("run.id", "run_1");
    span.setAttribute("apiKey", "sk-should-not-ship");
    span.setAttribute("authorization", "Bearer x");
    span.setAttribute("prompt", "the whole task");
    span.end();
    restore();
    const attrs = spans[0]!.attributes;
    expect(attrs["run.id"]).toBe("run_1");
    expect(Object.keys(attrs)).not.toContain("apiKey");
    expect(Object.keys(attrs)).not.toContain("authorization");
    expect(Object.keys(attrs)).not.toContain("prompt");
  });

  it("marks a failed span and lets the error through", async () => {
    const { spans, restore } = collect();
    await expect(
      withSpan({ name: "run.execute" }, async () => {
        throw new Error("budget expired");
      }),
    ).rejects.toThrow("budget expired");
    restore();
    expect(spans[0]!.status.code).toBe(2);
    expect(spans[0]!.status.message).toContain("budget expired");
  });

  it("keeps one span per call when the body runs twice", async () => {
    const { spans, restore } = collect();
    await withSpan({ name: "a" }, async () => 1);
    await withSpan({ name: "a" }, async () => 2);
    restore();
    expect(spans.filter((span) => span.name === "a")).toHaveLength(2);
  });
});
