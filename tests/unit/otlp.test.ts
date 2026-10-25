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

  it("sends an integer attribute as intValue and a fraction as doubleValue", () => {
    const wire = toOtlpPayload([
      span({ attributes: { "step.idx": 3, ratio: 0.5, ok: true } }),
    ]).resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(wire.attributes).toEqual([
      { key: "step.idx", value: { intValue: "3" } },
      { key: "ratio", value: { doubleValue: 0.5 } },
      { key: "ok", value: { boolValue: true } },
    ]);
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

  it("drains spans queued while a flush is in flight", async () => {
    // 5f332e7f 建议 5: a second flush() used to return the in-flight promise and
    // leave the newly queued spans behind, so a shutting-down process lost the
    // last batch — exactly the spans that describe the shutdown.
    const calls: Call[] = [];
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      await blocked;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const exporter = createOtlpSink({ endpoint: "http://collector:4318", fetchImpl: fakeFetch });

    exporter.sink(span({ spanId: "1".repeat(16) }));
    const first = exporter.flush();
    exporter.sink(span({ spanId: "2".repeat(16) }));
    const second = exporter.flush();
    release();
    await Promise.all([first, second]);

    const ids = calls.flatMap((call) =>
      JSON.parse(String(call.init.body)).resourceSpans[0].scopeSpans[0].spans.map(
        (wire: { spanId: string }) => wire.spanId,
      ),
    );
    expect(ids).toEqual(["1".repeat(16), "2".repeat(16)]);
    expect(exporter.pending()).toBe(0);
    exporter.stop();
  });

  it("stays usable across many sequential flushes", async () => {
    // Each flush chains onto the previous one so a shutdown cannot drop the
    // last batch. The chain must release itself when it settles: the release
    // itself is a reference in a closure, not visible from outside, so what
    // this pins is that a long series of flushes keeps sending exactly one
    // batch per cycle instead of silently sharing one settled promise.
    const { calls, fakeFetch } = recorder();
    const exporter = createOtlpSink({ endpoint: "http://collector:4318", fetchImpl: fakeFetch });
    for (let index = 0; index < 50; index += 1) {
      exporter.sink(span({ spanId: String(index).padStart(16, "0") }));
      await exporter.flush();
    }
    exporter.stop();

    expect(calls).toHaveLength(50);
    expect(
      calls.map(
        (call) =>
          JSON.parse(String(call.init.body)).resourceSpans[0].scopeSpans[0].spans.length,
      ),
    ).toEqual(Array.from({ length: 50 }, () => 1));
    expect(exporter.pending()).toBe(0);
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
