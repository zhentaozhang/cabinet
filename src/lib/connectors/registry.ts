import { braveConfigured, braveSearch } from "./search/brave";
import { tavilyConfigured, tavilySearch } from "./search/tavily";
import type { SearchOutcome, SearchRequest } from "./types";

export type SearchProvider = {
  name: string;
  search: (request: SearchRequest) => Promise<SearchOutcome>;
};

/** Brave first (better coverage), Tavily as the fallback. */
const PROVIDERS: SearchProvider[] = [
  { name: "brave", search: braveSearch },
  { name: "tavily", search: tavilySearch },
];

export function configuredSearchProviders(): SearchProvider[] {
  return PROVIDERS.filter((provider) =>
    provider.name === "brave" ? braveConfigured() : tavilyConfigured(),
  );
}

/** `null` means no provider has credentials — callers record `not_connected`. */
export function resolveSearchProvider(): SearchProvider | null {
  return configuredSearchProviders()[0] ?? null;
}

/**
 * Try each configured provider in order. Only `retryable` failures fall through
 * to the next provider: a 401 on Brave is a configuration problem, and quietly
 * billing Tavily instead would hide it.
 */
export async function searchWithFallback(
  request: SearchRequest,
): Promise<SearchOutcome> {
  const providers = configuredSearchProviders();
  if (providers.length === 0) {
    return {
      ok: false,
      provider: "none",
      latencyMs: 0,
      error: {
        code: "not_configured",
        message: "没有任何检索连接器已配置（BRAVE_API_KEY / TAVILY_API_KEY）。",
        retryable: false,
      },
    };
  }

  let last: SearchOutcome | null = null;
  for (const provider of providers) {
    const outcome = await provider.search(request);
    if (outcome.ok) return outcome;
    last = outcome;
    if (!outcome.error.retryable) return outcome;
  }
  return last as SearchOutcome;
}
