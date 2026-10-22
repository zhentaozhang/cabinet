import { normalizeHits, requestJson } from "../http";
import type { SearchOutcome, SearchRequest } from "../types";
import { SEARCH_RESULT_LIMIT } from "../types";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export function braveConfigured(): boolean {
  return Boolean(process.env.BRAVE_API_KEY);
}

/**
 * Brave Web Search. One request, no retries — retry policy belongs to the
 * caller so a failure is recorded once instead of hidden behind an attempt
 * loop.
 */
export async function braveSearch(request: SearchRequest): Promise<SearchOutcome> {
  const apiKey = process.env.BRAVE_API_KEY;
  const provider = "brave";
  if (!apiKey) {
    return {
      ok: false,
      provider,
      latencyMs: 0,
      error: {
        code: "not_configured",
        message: "未配置 BRAVE_API_KEY。",
        retryable: false,
      },
    };
  }

  const limit = request.limit || SEARCH_RESULT_LIMIT;
  const url = `${ENDPOINT}?q=${encodeURIComponent(request.query)}&count=${limit}`;
  const result = await requestJson({
    provider,
    url,
    fetchImpl: request.fetchImpl,
    timeoutMs: request.timeoutMs,
    init: {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-subscription-token": apiKey,
      },
    },
  });

  if (!result.ok) {
    return { ok: false, provider, latencyMs: result.latencyMs, error: result.error };
  }

  const body = result.body as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  const rows = body?.web?.results;
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      provider,
      latencyMs: result.latencyMs,
      error: {
        code: "invalid_response",
        message: "brave 响应里没有 web.results 数组。",
        retryable: false,
      },
    };
  }

  return {
    ok: true,
    provider,
    latencyMs: result.latencyMs,
    hits: normalizeHits(
      rows.map((row) => ({
        url: row.url,
        title: row.title,
        quote: row.description,
      })),
      limit,
    ),
  };
}
