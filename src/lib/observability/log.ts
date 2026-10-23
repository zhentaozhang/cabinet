import { currentRequestId } from "./context";

type Level = "info" | "warn" | "error";

/**
 * One JSON object per line.
 *
 * Structured rather than prose because these lines are read by a machine
 * first: `grep '"event":"mutation.failed"'` works, "something went wrong in
 * the approval handler" does not.
 */
export function logEvent(
  level: Level,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    level,
    event,
    requestId: currentRequestId(),
    ...fields,
  });

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Log an unexpected error with enough context to find it again. */
export function logError(
  event: string,
  error: unknown,
  fields: Record<string, unknown> = {},
): void {
  logEvent("error", event, {
    ...fields,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}
