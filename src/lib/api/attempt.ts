/**
 * Idempotency keys belong to *one user intent*, not to an endpoint.
 *
 * Background: the key used to be derived from `endpoint + body`, which is
 * stable forever. The server therefore replayed the first response of a
 * mutation for every later click, so "reject → run again" silently did
 * nothing. The key must change when the user starts a new intent, and stay
 * the same while a single intent is being retried (double click, transport
 * failure, timeout).
 *
 * Lifecycle:
 *   beginAttempt(scope)                 → new key for a new intent
 *   settleAttempt(scope, keep=true)     → transport failed, reuse the key
 *   settleAttempt(scope, keep=false)    → server answered, next click is new
 */

const pending = new Map<string, string>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** Identity of one intent: same method + path + body = same button press. */
export function attemptScope(
  method: string,
  path: string,
  body?: unknown,
): string {
  return `${method} ${path} ${body === undefined ? "" : stableStringify(body)}`;
}

function createKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `attempt-${uuid}`;
  // Non-crypto fallback for exotic runtimes; only needs to be unique.
  return `attempt-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/** Same key while the intent is still in flight, a fresh one afterwards. */
export function beginAttempt(scope: string): string {
  const existing = pending.get(scope);
  if (existing) return existing;
  const key = createKey();
  pending.set(scope, key);
  return key;
}

export function settleAttempt(scope: string, keepForRetry: boolean): void {
  if (!keepForRetry) pending.delete(scope);
}

/** Test/debug helpers. */
export function activeAttemptCount(): number {
  return pending.size;
}

export function resetAttempts(): void {
  pending.clear();
}
