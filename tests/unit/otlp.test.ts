import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinishedSpan } from "@/lib/observability/tracing";
import { createOtlpSink, toOtlpPayload } from "@/lib/observability/otlp";

function span(overrides: Partial<FinishedSpan> = {}): FinishedSpan {
  return {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    parentSpanId: null,
    name: "run.execute",
    kind: 1,
    startTimeUnixNano: BigInt("1700000000000000000"),
    endTimeUnixNano: BigInt("1700000000500000000"),
    attributes: { "run.id": "run_1" },
    status: { code: 2, message: "boom" },
    ...overrides,
  };
}

type Call = { url: string; init: RequestInit };

function recorder(response: Response = new Response("", { status: 200 })) {
  const calls: Call[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response.clone();
  }) as unknown as typeof fetch;
  return { calls, fakeFetch };
}

describe("otlp payload", () => {
  it("wraps spans in the resource/scope envelope the collector expects", () => {
    const payload = toOtlpPayload([span()]);
    const scope = payload.resourceSpans[0]!.scopeSpans[0]!;
    expect(payload.resourceSpans[0]!.resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "cabinet" },
    });
    expect(scope.spans).toHaveLength(1);
    expect(scope.spans[0]!.name).toBe("run.execute");
    expect(scope.spans[0]!.kind).toBe(1);
  });

  it("serialises int64 nanoseconds as decimal strings, not numbers", () => {
    const wire = toOtlpPayload([span()]).resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(wire.startTimeUnixNano).toBe("1700000000000000000");
    expect(wire.endTimeUnixNano).toBe("1700000000500000000");
  });

  it("converts attributes to OTLP key/value pairs and omits a null parent", () => {
    const wire = toOtlpPayload([span()]).resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(wire.attributes).toEqual([{ key: "run.id", value: { stringValue: "run_1" } }]);
    expect(wire.parentSpanId).toBeUndefined();
    expect(wire.status).toEqual({ code: 2, message: "boom" });
  });
});

describe("otlp exporter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts one batch to /v1/traces and strips a trailing slash", async () => {
    const { calls, fakeFetch } = recorder();
    const exporter = createOtlpSink({ endpoint: "http://collector:4318/", fetchImpl: fakeFetch });
    exporter.sink(span());
    exporter.sink(span({ spanId: "c".repeat(16) }));
    await exporter.flush();
    exporter.stop();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://collector:4318/v1/traces");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toMatchObject({ "content-type": "application/json" });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
  });

  it("empties the queue after a successful flush", async () => {
    const { fakeFetch } = recorder();
    const exporter = createOtlpSink({ endpoint: "http://collector:4318", fetchImpl: fakeFetch });
    exporter.sink(span());
    expect(exporter.pending()).toBe(1);
    await exporter.flush();
    expect(exporter.pending()).toBe(0);
    exporter.stop();
  });

  it("swallows a collector rejection instead of failing the caller", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fakeFetch } = recorder(new Response("nope", { status: 500 }));
    const exporter = createOtlpSink({ endpoint: "http://collector:4318", fetchImpl: fakeFetch });
    exporter.sink(span());
    await expect(exporter.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(exporter.pending()).toBe(0);
    exporter.stop();
  });

  it("survives a network error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const exporter = createOtlpSink({ endpoint: "http://collector:4318", fetchImpl: fakeFetch });
    exporter.sink(span());
    await expect(exporter.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    exporter.stop();
  });

  it("drops the oldest spans instead of growing without bound", async () => {
    const { calls, fakeFetch } = recorder();
    const exporter = createOtlpSink({
      endpoint: "http://collector:4318",
      fetchImpl: fakeFetch,
      maxBatch: 100,
      maxQueue: 2,
    });
    exporter.sink(span({ spanId: "1".repeat(16) }));
    exporter.sink(span({ spanId: "2".repeat(16) }));
    exporter.sink(span({ spanId: "3".repeat(16) }));
    expect(exporter.pending()).toBe(2);
    expect(exporter.dropped()).toBe(1);
    await exporter.flush();
    const body = JSON.parse(String(calls[0]!.init.body));
    const ids = body.resourceSpans[0].scopeSpans[0].spans.map(
      (wire: { spanId: string }) => wire.spanId,
    );
    expect(ids).toEqual(["2".repeat(16), "3".repeat(16)]);
    exporter.stop();
  });

  it("flushes immediately once the batch is full", async () => {
    const { calls, fakeFetch } = recorder();
    const exporter = createOtlpSink({
      endpoint: "http://collector:4318",
      fetchImpl: fakeFetch,
      maxBatch: 2,
    });
    exporter.sink(span());
    exporter.sink(span());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    exporter.stop();
  });
});
