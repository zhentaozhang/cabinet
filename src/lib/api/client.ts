import { z } from "zod";

import {
  apiFailureSchema,
  ERROR_CODE_LABEL,
  type ErrorCode,
} from "@/contracts/errors";

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
};

const DEFAULT_TIMEOUT_MS = 20_000;

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json");
}

function failure(
  code: ErrorCode,
  error: string,
  status: number,
): ClientResult<never> {
  return { ok: false, error: error || ERROR_CODE_LABEL[code], code, status };
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
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromCaller);

    let response: Response;
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
    } catch {
      const aborted = controller.signal.aborted;
      return failure(
        "internal_error",
        aborted ? "请求超时，请重试" : "网络异常，请检查连接",
        0,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }

    let payload: unknown = null;
    try {
      payload = isJsonResponse(response)
        ? await response.json()
        : null;
    } catch {
      payload = null;
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
          error: parsed.data.error,
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

    // Read endpoints answer `{ ok: true, data }`; mutation endpoints keep their
    // legacy flat shape `{ ok: true, ...fields }`. Unwrap only the former.
    const data = "data" in asRecord ? asRecord.data : (payload as T);

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
      return request(path, { schema });
    },
    mutate<T = Record<string, unknown>>(
      path: string,
      options: RequestOptions & { schema?: z.ZodType<T> } = {},
    ): Promise<ClientResult<T>> {
      return request<T>(path, {
        method: options.method ?? "POST",
        body: options.body,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
        schema: options.schema,
      });
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/**
 * Stable idempotency key for one *user intent*.
 *
 * Reusing a key across two different bodies makes the API answer 409 forever,
 * so the key is derived from the endpoint plus the payload actually sent.
 */
export function idempotencyKey(endpoint: string, body?: unknown): string {
  const seed = `${endpoint}:${body === undefined ? "" : JSON.stringify(body)}`;
  let hash = 5381;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) + hash + seed.charCodeAt(index)) >>> 0;
  }
  return `${endpoint.replace(/[^a-z0-9]+/gi, "-")}-${hash.toString(36)}`;
}
