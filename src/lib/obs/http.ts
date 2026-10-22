import { headers } from "next/headers";
import { after } from "next/server";

import {
  currentRequestContext,
  hashUserId,
  runWithRequestContext,
  type RequestContext,
} from "./context";
import { log, type LogFields } from "./logger";
import {
  REQUEST_ID_HEADER,
  REQUEST_METHOD_HEADER,
  REQUEST_PATH_HEADER,
  newRequestId,
  sanitizeRequestId,
  templateOfPath,
} from "./request-id";

/**
 * The request wrapper shared by `handleQuery` and `handleMutation`.
 *
 * Observed once, here, so every route handler is covered without touching any
 * of them: one unit of work in, exactly one access line out.
 */

async function incomingHeaders(): Promise<Headers | null> {
  try {
    return await headers();
  } catch {
    // Outside a request scope (unit tests, scripts): observe with defaults.
    return null;
  }
}

function schedule(task: () => void): void {
  try {
    // `after()` keeps logging off the response path: the user's bytes leave
    // before the dashboards are updated.
    after(() => {
      task();
    });
  } catch {
    // `after()` needs a request scope; fall back to logging inline.
    task();
  }
}

function fieldsOf(context: RequestContext): LogFields {
  const fields: LogFields = {
    requestId: context.requestId,
    method: context.method,
    path: context.path,
    route: context.route,
    kind: context.kind,
  };
  // The context is mutable: authentication fills `userId` in mid-flight, so
  // this must be read at emit time rather than at creation time.
  if (context.userId) fields.user = hashUserId(context.userId);
  return fields;
}

export async function runHttpRequest(
  kind: "query" | "mutation",
  run: () => Promise<Response>,
): Promise<Response> {
  const startedAt = Date.now();
  const incoming = await incomingHeaders();

  const requestId =
    sanitizeRequestId(incoming?.get(REQUEST_ID_HEADER)) ?? newRequestId();
  const path = incoming?.get(REQUEST_PATH_HEADER) ?? "";
  const context: RequestContext = {
    requestId,
    method: incoming?.get(REQUEST_METHOD_HEADER) ?? "",
    path,
    route: templateOfPath(path),
    kind,
    startedAt,
  };

  return runWithRequestContext(context, async () => {
    let response: Response;
    try {
      response = await run();
    } catch (error) {
      // The pipelines catch their own errors; this is the last line of defence
      // so an unexpected throw still produces a log instead of a silent 500.
      log("error", "http.unhandled", {
        ...fieldsOf(context),
        durMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      // Still emit the terminal access line: an invariant of this module is
      // that one request produces exactly one of them, however it ends.
      const failed = { ...fieldsOf(context), status: 500, durMs: Date.now() - startedAt };
      schedule(() => log("error", "http.request", failed));

      throw error;
    }

    try {
      response.headers.set(REQUEST_ID_HEADER, requestId);
    } catch {
      // Immutable headers (a fetched response) are not worth failing over.
    }

    const status = response.status;
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    // Capture eagerly: `after()` does not promise the async context is still
    // installed when the callback runs.
    const fields = {
      ...fieldsOf(context),
      status,
      durMs: Date.now() - startedAt,
    };

    schedule(() => log(level, "http.request", fields));
    return response;
  });
}

/**
 * Read the correlation id of the request being served. Used by the server-side
 * API client so the RSC → `/api/*` hop inherits the page's identifier instead
 * of starting an unrelated trace.
 */
export function currentRequestId(): string | undefined {
  return currentRequestContext()?.requestId;
}
