import { normalizeHits, requestJson } from "../http";
import type { SearchOutcome, SearchRequest } from "../types";
import { SEARCH_RESULT_LIMIT } from "../types";

const ENDPOINT = "https://api.tavily.com/search";

export function tavilyConfigured(): boolean {
  return Boolean(process.env.TAVILY_API_KEY);
}

/** Tavily Search, used as the fallback provider when Brave is unavailable. */
export async function tavilySearch(request: SearchRequest): Promise<SearchOutcome> {
  const apiKey = process.env.TAVILY_API_KEY;
  const provider = "tavily";
  if (!apiKey) {
    return {
      ok: false,
      provider,
      latencyMs: 0,
      error: {
        code: "not_configured",
        message: "未配置 TAVILY_API_KEY。",
        retryable: false,
      },
    };
  }

  const limit = request.limit || SEARCH_RESULT_LIMIT;
  const result = await requestJson({
    provider,
    url: ENDPOINT,
    fetchImpl: request.fetchImpl,
    timeoutMs: request.timeoutMs,
    init: {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: request.query,
        max_results: limit,
        search_depth: "basic",
        include_answer: false,
      }),
    },
  });

  if (!result.ok) {
    return { ok: false, provider, latencyMs: result.latencyMs, error: result.error };
  }

  const body = result.body as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const rows = body?.results;
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      provider,
      latencyMs: result.latencyMs,
      error: {
        code: "invalid_response",
        message: "tavily 响应里没有 results 数组。",
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
        quote: row.content,
      })),
      limit,
    ),
  };
}
