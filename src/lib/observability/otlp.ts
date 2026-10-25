import { logEvent } from "./log";
import { setSpanSink, type FinishedSpan, type SpanAttribute } from "./tracing";

/**
 * A hand-rolled OTLP/HTTP exporter.
 *
 * It speaks the same JSON the collector accepts (`POST {endpoint}/v1/traces`),
 * so a run shows up in Jaeger/Tempo/Grafana exactly like an SDK-exported trace.
 * The trade-off is explicit: no batching guarantees, no retry budget, no
 * compression. A dropped export is logged and forgotten — telemetry must never
 * be the reason a task fails.
 */

const DEFAULT_MAX_BATCH = 32;
const DEFAULT_FLUSH_MS = 5_000;
/**
 * Hard ceiling on the in-memory queue. A collector that is up but slow (or a
 * fetch that never settles) must not turn telemetry into an OOM: past this
 * point the oldest spans are dropped and counted.
 */
const DEFAULT_MAX_QUEUE = 512;

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

type WireSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: AnyValue }>;
  status: { code: number; message?: string };
};

export type OtlpPayload = {
  resourceSpans: Array<{
    resource: { attributes: Array<{ key: string; value: AnyValue }> };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: WireSpan[];
    }>;
  }>;
};

function anyValue(value: SpanAttribute): AnyValue {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    // Typed as the collector expects, so a backend can sum step.idx and
    // max_tokens instead of receiving every number as a string.
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  return { stringValue: value };
}

function toWireSpan(span: FinishedSpan): WireSpan {
  const wire: WireSpan = {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    kind: span.kind,
    // int64 must be a decimal string: 1.7e18 loses precision as a double.
    startTimeUnixNano: span.startTimeUnixNano.toString(),
    endTimeUnixNano: span.endTimeUnixNano.toString(),
    attributes: Object.entries(span.attributes).map(([key, value]) => ({
      key,
      value: anyValue(value),
    })),
    status: span.status,
  };
  if (span.parentSpanId) wire.parentSpanId = span.parentSpanId;
  return wire;
}

export function toOtlpPayload(spans: FinishedSpan[]): OtlpPayload {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "cabinet" } },
            {
              key: "deployment.environment",
              value: { stringValue: process.env.NODE_ENV ?? "development" },
            },
          ],
        },
        scopeSpans: [
          {
            scope: {
              name: "cabinet",
              version: process.env.npm_package_version ?? "0.0.0",
            },
            spans: spans.map(toWireSpan),
          },
        ],
      },
    ],
  };
}

export type OtlpExporter = {
  sink: (span: FinishedSpan) => void;
  flush: () => Promise<void>;
  pending: () => number;
  /** Spans discarded because the queue was full; a silent drop is a blind spot. */
  dropped: () => number;
  stop: () => void;
};

export function createOtlpSink(options: {
  endpoint: string;
  fetchImpl?: typeof fetch;
  maxBatch?: number;
  maxQueue?: number;
  flushIntervalMs?: number;
}): OtlpExporter {
  const url = `${options.endpoint.replace(/\/+$/, "")}/v1/traces`;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH;
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;

  let queue: FinishedSpan[] = [];
  let flushing: Promise<void> | null = null;
  let stopped = false;
  let dropped = 0;

  /** Send one batch. Never rejects: telemetry must not fail its caller. */
  async function send(batch: FinishedSpan[]): Promise<void> {
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toOtlpPayload(batch)),
      });
      if (!response.ok) {
        logEvent("warn", "otlp.export.failed", {
          status: response.status,
          spans: batch.length,
        });
      }
    } catch (error) {
      logEvent("warn", "otlp.export.failed", {
        spans: batch.length,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Drain the queue, one batch at a time.
   *
   * Concurrent calls are chained rather than short-circuited: the second caller
   * is usually a shutdown, and returning the first caller's promise would leave
   * whatever it queued behind (5f332e7f 建议 5). Each link re-checks the queue,
   * so spans arriving mid-flight are sent by the next pass, not dropped.
   */
  function flush(): Promise<void> {
    const pass = async (): Promise<void> => {
      while (queue.length > 0) {
        const batch = queue;
        queue = [];
        await send(batch);
      }
    };
    const next = flushing ? flushing.then(pass) : pass();
    flushing = next.finally(() => {
      if (flushing === next) flushing = null;
    });
    return flushing;
  }

  const timer = setInterval(() => void flush(), options.flushIntervalMs ?? DEFAULT_FLUSH_MS);
  // An unref'd timer keeps a short-lived process from hanging on telemetry.
  timer.unref?.();

  return {
    sink(span) {
      if (stopped) return;
      queue.push(span);
      if (queue.length > maxQueue) {
        const overflow = queue.length - maxQueue;
        queue.splice(0, overflow);
        dropped += overflow;
      }
      if (queue.length >= maxBatch) void flush();
    },
    flush,
    pending: () => queue.length,
    dropped: () => dropped,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Wire the exporter when the environment asks for one. Called from
 * `src/instrumentation.ts`; returns false so a caller can log "tracing off".
 */
export function installOtlpExporterIfConfigured(): boolean {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return false;
  const exporter = createOtlpSink({ endpoint });
  setSpanSink(exporter.sink);
  process.once("beforeExit", () => void exporter.flush());
  return true;
}
