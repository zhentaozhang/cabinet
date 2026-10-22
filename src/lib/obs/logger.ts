/**
 * The logging sink.
 *
 * One JSON object per line on stdout, nothing else. The platform collector
 * owns shipping, rotation and retention; this module owns only the shape and
 * the promise that logging can never break a request.
 *
 * Deliberately dependency-free: no `node:*` imports, no third-party logger.
 * That keeps it importable from any runtime and keeps the bundle honest.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

const WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_LEVEL: LogLevel = "info";

/**
 * Keys whose *values* are user content or credentials. Matched against the key
 * name, so `tokensIn` survives while `content` does not: observability records
 * shapes and identifiers, never the things a user typed.
 */
const REDACT_KEY = [
  /^content/i,
  /^prompt/i,
  /^text$/i,
  /^body$/i,
  /^input$/i,
  /^output$/i,
  /^memor/i,
  /^description$/i,
  /^email$/i,
  /^cookie$/i,
  /^authorization$/i,
  /^password$/i,
  /^secret/i,
  /^api_?key$/i,
  /^title$/i,
  /^charter$/i,
  /^acceptance/i,
];

const REDACTED = "[redacted]";
const MAX_DEPTH = 4;
const MAX_ITEMS = 20;
const MAX_STRING = 400;

function isLevel(value: string): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function threshold(): number {
  const raw =
    typeof process !== "undefined" ? process.env.OBS_LOG_LEVEL : undefined;
  const name = (raw ?? DEFAULT_LEVEL).toLowerCase();
  return isLevel(name) ? WEIGHT[name] : WEIGHT[DEFAULT_LEVEL];
}

/** Errors become structured, bounded fields instead of unreadable blobs. */
export function serialiseError(error: unknown): LogFields {
  if (!(error instanceof Error)) {
    return { errorName: typeof error, errorMessage: String(error) };
  }

  const fields: LogFields = {
    errorName: error.name,
    errorMessage: error.message,
    stack: (error.stack ?? "").split("\n").slice(0, 4).join("\n"),
  };

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") fields.code = code;

  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") fields.status = status;

  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) fields.cause = cause.message;

  return fields;
}

function scrub(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return serialiseError(value);
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (depth >= MAX_DEPTH) return "[depth]";

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => scrub(item, depth + 1));
  }

  const out: LogFields = {};
  for (const [key, inner] of Object.entries(value as LogFields)) {
    out[key] = REDACT_KEY.some((pattern) => pattern.test(key))
      ? REDACTED
      : scrub(inner, depth + 1);
  }
  return out;
}

function emit(line: string): void {
  try {
    if (typeof process !== "undefined" && process.stdout?.write) {
      process.stdout.write(`${line}\n`);
      return;
    }
  } catch {
    // Fall through: a broken stdout must not take a request with it.
  }
  try {
    console.log(line);
  } catch {
    // Logging is best-effort by construction.
  }
}

/**
 * Write one structured line. Never throws, never awaits, never buffers beyond
 * the current call.
 */
export function log(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): void {
  if (WEIGHT[level] < threshold()) return;

  try {
    const record: LogFields = {
      ts: new Date().toISOString(),
      level,
      event,
    };

    // Sensitive keys are matched at the top level too: the caller's own object
    // is the most likely place for a draft or a prompt to appear.
    for (const [key, value] of Object.entries(fields)) {
      if (REDACT_KEY.some((pattern) => pattern.test(key))) {
        record[key] = REDACTED;
        continue;
      }
      const scrubbed = scrub(value, 0);
      if (scrubbed !== undefined) record[key] = scrubbed;
    }

    emit(JSON.stringify(record));
  } catch {
    // A serializer failure must not surface to the caller.
  }
}
