import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Spans without a dependency.
 *
 * The alternative is `@opentelemetry/sdk-node` — ~80 transitive packages for
 * what is, at this size, one JSON payload and a fetch. We keep the data model
 * the OTLP spec defines and drop everything else.
 */

/** OTLP span kind: 1 = INTERNAL, 2 = SERVER. */
export type SpanKind = 1 | 2;
/** OTLP status: 0 = unset, 1 = ok, 2 = error. */
export type SpanStatusCode = 0 | 1 | 2;
export type SpanAttribute = string | number | boolean;

export type FinishedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  /** OTLP int64 nanoseconds; bigint because 1.7e18 overflows a JS number. */
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Record<string, SpanAttribute>;
  status: { code: SpanStatusCode; message?: string };
};

export type Span = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  setAttribute(key: string, value: unknown): void;
  setStatus(code: SpanStatusCode, message?: string): void;
  end(): void;
};

type SpanSink = (span: FinishedSpan) => void;

const storage = new AsyncLocalStorage<Span>();
let sink: SpanSink | null = null;

/** True when a collector endpoint is configured; exporting is off otherwise. */
export function tracingEnabled(): boolean {
  return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

/** Install (or clear) the exporter. Exported for tests and for startup wiring. */
export function setSpanSink(next: SpanSink | null): void {
  sink = next;
}

/** The span the current async context is inside, if any. */
export function currentSpan(): Span | null {
  return storage.getStore() ?? null;
}

/**
 * Attribute keys we refuse to record.
 *
 * A span is shipped to a third party; the prompt, the model key and the task
 * body live one `setAttribute` away from leaving the building. Deny by pattern
 * rather than allow-list so a new call site fails closed.
 */
const SECRET_KEY = /secret|token|password|authorization|api[-_]?key|prompt|content|payload|body/i;
const MAX_ATTR_LEN = 256;

function coerce(value: unknown): SpanAttribute | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.length > MAX_ATTR_LEN ? value.slice(0, MAX_ATTR_LEN) : value;
  return null;
}

function hex(len: number): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, len);
}

/**
 * Wall clock in OTLP nanoseconds.
 *
 * `BigInt()` calls rather than `n` literals: the project targets ES2017, where
 * bigint literals are a compile error even though the runtime supports them.
 */
const NANOS_PER_MILLI = BigInt(1_000_000);

function nowNano(): bigint {
  return BigInt(Date.now()) * NANOS_PER_MILLI;
}

export function startSpan(input: {
  name: string;
  kind?: SpanKind;
  attributes?: Record<string, unknown>;
}): Span {
  const parent = storage.getStore() ?? null;
  const attributes: Record<string, SpanAttribute> = {};
  for (const [key, value] of Object.entries(input.attributes ?? {})) {
    if (SECRET_KEY.test(key)) continue;
    const coerced = coerce(value);
    if (coerced !== null) attributes[key] = coerced;
  }

  const span: Span = {
    traceId: parent?.traceId ?? hex(32),
    spanId: hex(16),
    parentSpanId: parent?.spanId ?? null,
    setAttribute(key, value) {
      if (SECRET_KEY.test(key)) return;
      const coerced = coerce(value);
      if (coerced !== null) attributes[key] = coerced;
    },
    setStatus(code, message) {
      status = message === undefined ? { code } : { code, message };
    },
    end() {
      if (ended) return;
      ended = true;
      const finished: FinishedSpan = {
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: input.name,
        kind: input.kind ?? 1,
        startTimeUnixNano: start,
        endTimeUnixNano: start + (process.hrtime.bigint() - startedAt),
        attributes,
        status,
      };
      try {
        sink?.(finished);
      } catch {
        // An exporter must never take the request down with it.
      }
    },
  };

  const startedAt = process.hrtime.bigint();
  const start = nowNano();
  let status: { code: SpanStatusCode; message?: string } = { code: 0 };
  let ended = false;

  return span;
}

/**
 * Run `fn` inside a span: children inherit the trace, errors set the status,
 * and the span ends exactly once even when the body throws.
 */
export async function withSpan<T>(
  input: { name: string; kind?: SpanKind; attributes?: Record<string, unknown> },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = startSpan(input);
  try {
    return await storage.run(span, () => fn(span));
  } catch (error) {
    span.setStatus(2, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    span.end();
  }
}
