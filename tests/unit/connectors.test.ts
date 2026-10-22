import { afterEach, describe, expect, it, vi } from "vitest";

import { braveSearch } from "@/lib/connectors/search/brave";
import { tavilySearch } from "@/lib/connectors/search/tavily";
import { searchWithFallback } from "@/lib/connectors/registry";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("brave connector", () => {
  it("returns normalised, citable hits", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        web: {
          results: [
            {
              title: "RAG 综述",
              url: "https://example.com/rag",
              description: "检索增强生成把外部知识注入上下文。",
            },
            { title: "没有摘要的结果", url: "https://example.com/empty" },
          ],
        },
      }),
    ) as unknown as typeof fetch;

    const outcome = await braveSearch({ query: "rag", limit: 5, fetchImpl });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.provider).toBe("brave");
    expect(outcome.hits).toHaveLength(1);
    expect(outcome.hits[0]).toMatchObject({
      url: "https://example.com/rag",
      quote: "检索增强生成把外部知识注入上下文。",
      publisher: "example.com",
    });
  });

  it("reports a missing key as not_configured", async () => {
    delete process.env.BRAVE_API_KEY;
    const outcome = await braveSearch({ query: "rag", limit: 5 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("not_configured");
    expect(outcome.error.retryable).toBe(false);
  });

  it("maps 401 to a non-retryable credential failure", async () => {
    process.env.BRAVE_API_KEY = "bad";
    const fetchImpl = vi.fn(
      async () => new Response("unauthorized", { status: 401 }),
    ) as unknown as typeof fetch;
    const outcome = await braveSearch({ query: "rag", limit: 5, fetchImpl });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("unauthorized");
    expect(outcome.error.retryable).toBe(false);
  });

  it("maps 429 to a retryable rate limit", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    const fetchImpl = vi.fn(
      async () => new Response("slow down", { status: 429 }),
    ) as unknown as typeof fetch;
    const outcome = await braveSearch({ query: "rag", limit: 5, fetchImpl });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("rate_limited");
    expect(outcome.error.retryable).toBe(true);
  });

  it("flags a non-JSON body instead of parsing it", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    const fetchImpl = vi.fn(
      async () => new Response("<html>gateway</html>", { status: 200 }),
    ) as unknown as typeof fetch;
    const outcome = await braveSearch({ query: "rag", limit: 5, fetchImpl });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid_response");
  });

  it("times out instead of hanging", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    ) as unknown as typeof fetch;
    const outcome = await braveSearch({
      query: "rag",
      limit: 5,
      fetchImpl,
      timeoutMs: 5,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("timeout");
  });
});

describe("tavily connector", () => {
  it("posts the query and normalises content to quotes", async () => {
    process.env.TAVILY_API_KEY = "tvly-key";
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [
          {
            title: "Rerank 对比",
            url: "https://arxiv.example/rerank",
            content: "cross-encoder 在召回后重排优于纯向量检索。",
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const outcome = await tavilySearch({ query: "rerank", limit: 3, fetchImpl });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.hits[0].quote).toContain("cross-encoder");
    const [, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("rerank");
  });
});

describe("provider registry", () => {
  it("falls back to tavily only on a retryable failure", async () => {
    process.env.BRAVE_API_KEY = "brave-key";
    process.env.TAVILY_API_KEY = "tavily-key";
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("brave")
        ? new Response("slow", { status: 429 })
        : jsonResponse({
            results: [
              { title: "T", url: "https://t.example/a", content: "evidence" },
            ],
          }),
    ) as unknown as typeof fetch;

    const outcome = await searchWithFallback({ query: "x", limit: 3, fetchImpl });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.provider).toBe("tavily");
  });

  it("does not silently switch providers on a credential error", async () => {
    process.env.BRAVE_API_KEY = "brave-key";
    process.env.TAVILY_API_KEY = "tavily-key";
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 401 }),
    ) as unknown as typeof fetch;

    const outcome = await searchWithFallback({ query: "x", limit: 3, fetchImpl });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.provider).toBe("brave");
    expect(outcome.error.code).toBe("unauthorized");
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls)
      .toHaveLength(1);
  });

  it("reports not_configured when no provider has a key", async () => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.TAVILY_API_KEY;
    const outcome = await searchWithFallback({ query: "x", limit: 3 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("not_configured");
  });
});
