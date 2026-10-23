import { z } from "zod";

import {
  apiFailureSchema,
  ERROR_CODE_LABEL,
  type ErrorCode,
} from "@/contracts/errors";
import { attemptScope, beginAttempt, settleAttempt } from "./attempt";

/**
 * The only place the frontend is allowed to talk to the backend.
 *
 * Invariants:
 * - never throws: every failure is returned as a discriminated union, so a
 *   component can always reset its busy state;
 * - always reads the body defensively (non-JSON 500 pages, provider HTML,
 *   truncated responses) instead of assuming JSON;
 * - surfaces the transport `code` so callers can branch on policy_denied /
 *   rate_limited / conflict, not just on a string.
 */
export type ClientResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: ErrorCode; status: number };

export type ApiClientConfig = {
  /** "" for same-origin calls from the browser, absolute URL from the server. */
  baseUrl: string;
  /** Resolved per request (cookie jar, tracing headers, ...). */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  credentials?: RequestCredentials;
  timeoutMs?: number;
};

export type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /**
   * How the success body is shaped. Read endpoints answer
   * `{ ok: true, data }`; mutation endpoints answer `{ ok: true, ...fields }`.
   * The shape is declared by the caller, never sniffed from the payload: a
   * mutation that happens to return a field named `data` must not be unwrapped.
   */
  envelope?: "data" | "flat";
};

const DEFAULT_TIMEOUT_MS = 20_000;

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json");
}

/**
 * Server messages that are really just the enum spelled out in English. A user
 * reading "Internal error" learns nothing, so those fall back to the code's
 * own sentence; anything the server wrote deliberately is kept as-is.
 */
const PLACEHOLDER_MESSAGES = new Set([
  "Internal error",
  "Unauthorized",
  "Forbidden",
  "Not found",
  "Validation failed",
  "Conflict",
]);

function failure(
  code: ErrorCode,
  error: string,
  status: number,
): ClientResult<never> {
  const message =
    !error || PLACEHOLDER_MESSAGES.has(error) ? ERROR_CODE_LABEL[code] : error;
  return { ok: false, error: message, code, status };
}

export function createApiClient(config: ApiClientConfig) {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(
    path: string,
    options: RequestOptions & { schema?: z.ZodType<T> } = {},
  ): Promise<ClientResult<T>> {
    const method = options.method ?? "GET";
    const base = config.baseUrl.replace(/\/$/, "");

    let extraHeaders: Record<string, string> = {};
    try {
      extraHeaders = (await config.headers?.()) ?? {};
    } catch {
      return failure("unauthorized", "无法读取当前会话", 401);
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      ...extraHeaders,
    };
    if (method !== "GET" && options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (options.idempotencyKey) {
      headers["idempotency-key"] = options.idempotencyKey;
    }

    const controller = new AbortController();
    // The timer has to outlive `fetch()` itself. A server can answer with
    // headers promptly and then stall the body forever; clearing the timer the
    // moment headers arrive would leave the caller's busy state stuck with
    // nothing left to cancel it. So the read below stays inside the same
    // window, and an abort raised mid-stream is reported as a timeout rather
    // than as a malformed response.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortFromCaller = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromCaller);

    let response: Response | null = null;
    let payload: unknown = null;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers,
        body:
          method === "GET" || options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
        cache: "no-store",
        credentials: config.credentials ?? "same-origin",
        signal: controller.signal,
      });
      // Aborting while the body streams rejects this read, not the `fetch()`
      // above, so it belongs in the same try for the timeout to cover it.
      payload = isJsonResponse(response) ? await response.json() : null;
    } catch {
      if (timedOut) {
        return failure("internal_error", "请求超时，请重试", 0);
      }
      if (!response) {
        return failure("internal_error", "网络异常，请检查连接", 0);
      }
      // Headers arrived but the body could not be decoded as JSON.
      payload = null;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }

    if (!response) {
      return failure("internal_error", "网络异常，请检查连接", 0);
    }

    if (payload === null) {
      return failure(
        response.status === 401 ? "unauthorized" : "internal_error",
        response.status === 401
          ? "登录状态已失效"
          : `服务端返回了非 JSON 响应 (${response.status})`,
        response.status,
      );
    }

    const asRecord = payload as Record<string, unknown>;

    if (!response.ok || asRecord.ok === false) {
      const parsed = apiFailureSchema.safeParse(payload);
      if (parsed.success) {
        return {
          ok: false,
          error: PLACEHOLDER_MESSAGES.has(parsed.data.error)
            ? ERROR_CODE_LABEL[parsed.data.code]
            : parsed.data.error,
          code: parsed.data.code,
          status: response.status,
        };
      }
      return failure(
        response.status === 401 ? "unauthorized" : "internal_error",
        `请求失败 (${response.status})`,
        response.status,
      );
    }

    const data =
      options.envelope === "flat"
        ? (payload as T)
        : // `query()` declares "data"; anything else falls back to the read shape
          // so a forgotten option cannot silently hand back the whole envelope.
          (asRecord.data as T);

    if (options.schema) {
      const parsed = options.schema.safeParse(data);
      if (!parsed.success) {
        return failure(
          "internal_error",
          `接口返回不符合契约：${parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
            .join("; ")}`,
          502,
        );
      }
      return { ok: true, data: parsed.data };
    }

    return { ok: true, data: data as T };
  }

  return {
    request,
    query<T>(path: string, schema: z.ZodType<T>): Promise<ClientResult<T>> {
      return request(path, { schema, envelope: "data" });
    },
    async mutate<T = Record<string, unknown>>(
      path: string,
      options: RequestOptions & { schema?: z.ZodType<T> } = {},
    ): Promise<ClientResult<T>> {
      const method = options.method ?? "POST";
      const scope = attemptScope(method, path, options.body);
      const explicitKey = options.idempotencyKey;
      // One intent = one key. A transport failure keeps the key so a retry is
      // deduplicated; any server answer releases it so the *next* click is a
      // new intent (e.g. "run again" after a rejection).
      const idempotencyKey = explicitKey ?? beginAttempt(scope);

      const result = await request<T>(path, {
        method,
        body: options.body,
        idempotencyKey,
        signal: options.signal,
        schema: options.schema,
        envelope: options.envelope ?? "data",
      });

      if (!explicitKey) {
        settleAttempt(scope, result.ok === false && result.status === 0);
      }
      return result;
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
