import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import { log, serialiseError, type LogFields, type LogLevel } from "./logger";

/**
 * Per-request observability context.
 *
 * Node runtime only: `AsyncLocalStorage` lets a service three calls deep attach
 * its event to the request that caused it without threading a parameter
 * through every signature. `src/proxy.ts` runs on the edge runtime and must
 * never import this module — it forwards identifiers through headers instead.
 */

export type RequestContext = {
  requestId: string;
  method: string;
  path: string;
  route: string;
  kind: "query" | "mutation" | "page" | "job";
  startedAt: number;
  userId?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

const HASH_CACHE_LIMIT = 1000;
const hashes = new Map<string, string>();

/**
 * Pseudonymous user handle. The raw id is a foreign key; logs get a salted
 * digest so a log dump cannot be joined back to `users` by a third party.
 */
export function hashUserId(userId: string): string {
  const cached = hashes.get(userId);
  if (cached) return cached;

  const salt = process.env.OBS_USER_SALT ?? "cabinet-local-salt";
  const digest = createHash("sha256")
    .update(`${salt}:${userId}`)
    .digest("hex")
    .slice(0, 8);
  const handle = `u_${digest}`;

  if (hashes.size < HASH_CACHE_LIMIT) hashes.set(userId, handle);
  return handle;
}

export function runWithRequestContext<T>(
  context: RequestContext,
  run: () => T,
): T {
  return storage.run(context, run);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Attach the resolved tenant to the in-flight context. Authentication happens
 * inside the pipeline, after the context already exists.
 */
export function bindUser(userId: string): void {
  const context = storage.getStore();
  if (context) context.userId = userId;
}

function contextFields(): LogFields {
  const context = storage.getStore();
  if (!context) return {};

  const fields: LogFields = {
    requestId: context.requestId,
    method: context.method,
    path: context.path,
    route: context.route,
    kind: context.kind,
  };

  if (context.userId) fields.user = hashUserId(context.userId);
  return fields;
}

/**
 * Log with the active request merged in. Every server module should call this
 * rather than `log()` so a single `requestId` stitches the whole request back
 * together — including the inner RSC → `/api/*` hop.
 */
export function logEvent(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): void {
  log(level, event, { ...contextFields(), ...fields });
}

/** Log an exception together with its location in the request. */
export function logError(event: string, error: unknown, fields: LogFields = {}): void {
  logEvent("error", event, { ...serialiseError(error), ...fields });
}
