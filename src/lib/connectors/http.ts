import type { ConnectorError, SearchHit } from "./types";
import { SEARCH_TIMEOUT_MS } from "./types";

export class ConnectorHttpError extends Error {
  constructor(readonly error: ConnectorError) {
    super(error.message);
    this.name = "ConnectorHttpError";
  }
}

/** HTTP status → connector error. Kept in one place so providers agree. */
export function errorForStatus(status: number, provider: string): ConnectorError {
  if (status === 401 || status === 403) {
    return {
      code: "unauthorized",
      message: `${provider} 拒绝了凭证（HTTP ${status}）。请检查 API key 是否有效。`,
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      code: "rate_limited",
      message: `${provider} 触发限流（HTTP 429）。`,
      retryable: true,
    };
  }
  if (status >= 500) {
    return {
      code: "network_error",
      message: `${provider} 返回 ${status}，稍后可重试。`,
      retryable: true,
    };
  }
  return {
    code: "invalid_response",
    message: `${provider} 返回了意外的状态码 ${status}。`,
    retryable: false,
  };
}

/**
 * GET/POST JSON with a hard timeout and typed failures.
 *
 * Returns `{ ok: false }` for every provider condition, so a caller can record
 * the failure instead of losing it in a catch block.
 */
export async function requestJson(input: {
  provider: string;
  url: string;
  init?: RequestInit;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<
  | { ok: true; body: unknown; latencyMs: number }
  | { ok: false; error: ConnectorError; latencyMs: number }
> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? SEARCH_TIMEOUT_MS,
  );
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(input.url, {
      ...input.init,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return { ok: false, error: errorForStatus(response.status, input.provider), latencyMs };
    }

    const text = await response.text();
    try {
      return { ok: true, body: JSON.parse(text) as unknown, latencyMs };
    } catch {
      return {
        ok: false,
        latencyMs,
        error: {
          code: "invalid_response",
          message: `${input.provider} 返回了非 JSON 响应，可能是网关错误页。`,
          retryable: false,
        },
      };
    }
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const aborted =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");
    return {
      ok: false,
      latencyMs,
      error: aborted
        ? {
            code: "timeout",
            message: `${input.provider} 在 ${input.timeoutMs ?? SEARCH_TIMEOUT_MS}ms 内没有响应。`,
            retryable: true,
          }
        : {
            code: "network_error",
            message: `${input.provider} 请求失败：${error instanceof Error ? error.message : String(error)}`,
            retryable: true,
          },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Publisher fallback: the bare host, so a citation is never anonymous. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Keep only hits we can actually cite: a resolvable http(s) URL and a non-empty
 * verbatim quote. A result without a quote is not evidence, it is a headline.
 */
export function normalizeHits(
  rows: Array<{ url?: unknown; title?: unknown; quote?: unknown; publisher?: unknown }>,
  limit: number,
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const row of rows) {
    if (typeof row.url !== "string" || !/^https?:\/\//.test(row.url)) continue;
    const quote = typeof row.quote === "string" ? row.quote.trim() : "";
    if (!quote) continue;
    const title =
      typeof row.title === "string" && row.title.trim()
        ? row.title.trim()
        : (hostOf(row.url) ?? row.url);
    hits.push({
      url: row.url,
      title,
      quote,
      publisher:
        typeof row.publisher === "string" && row.publisher.trim()
          ? row.publisher.trim()
          : hostOf(row.url),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
