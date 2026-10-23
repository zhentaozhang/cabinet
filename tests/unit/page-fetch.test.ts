import { describe, expect, it } from "vitest";
import {
  extractFirstUrl,
  fetchPage,
  firstQuote,
  htmlToText,
  isBlockedHost,
  pageTitle,
} from "@/lib/connectors/page";

/** A fetch stand-in: no sockets, no DNS, fully deterministic. */
function responseFor(
  body: string,
  init: { status?: number; contentType?: string; url?: string } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      "content-type": init.contentType ?? "text/html; charset=utf-8",
    },
  });
}

describe("extractFirstUrl", () => {
  it("finds a URL written inline in prose", () => {
    expect(
      extractFirstUrl("看看 https://example.com/a?b=1 这篇，然后写笔记。"),
    ).toBe("https://example.com/a?b=1");
  });

  it("strips trailing punctuation that belongs to the sentence", () => {
    expect(extractFirstUrl("见 https://example.com/x）")).toBe("https://example.com/x");
  });

  it("returns null when the task names no URL", () => {
    expect(extractFirstUrl("读一下 RAG 综述，写 3 行笔记。")).toBeNull();
  });

  it("rejects non-http schemes", () => {
    expect(extractFirstUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("isBlockedHost", () => {
  it("blocks loopback and reserved literals", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.1",
      "172.16.5.4",
      "169.254.169.254",
      "::1",
      "printer.local",
    ]) {
      expect(isBlockedHost(host), host).toBe(true);
    }
  });

  it("allows public hosts", () => {
    for (const host of ["example.com", "arxiv.org", "8.8.8.8"]) {
      expect(isBlockedHost(host), host).toBe(false);
    }
  });
});

describe("htmlToText", () => {
  it("drops scripts and styles, keeps readable prose", () => {
    const text = htmlToText(
      "<html><head><style>.a{color:red}</style><script>alert(1)</script></head>" +
        "<body><h1>标题</h1><p>第一段 &amp; 第二句</p><div>尾巴</div></body></html>",
    );
    expect(text).toContain("标题");
    expect(text).toContain("第一段 & 第二句");
    expect(text).toContain("尾巴");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });

  it("reads the document title, falling back to the host", () => {
    expect(pageTitle("<title> RAG 综述 </title>", "https://example.com/x")).toBe("RAG 综述");
    expect(pageTitle("<html></html>", "https://example.com/x")).toBe("example.com");
  });

  it("quotes the opening of the text, not the whole page", () => {
    const quote = firstQuote("词 ".repeat(600));
    expect(quote.length).toBeLessThanOrEqual(301);
    expect(quote.endsWith("…")).toBe(true);
  });
});

describe("fetchPage", () => {
  it("returns title, text and a quote for an HTML page", async () => {
    const outcome = await fetchPage({
      url: "https://example.com/post",
      fetchImpl: async () =>
        responseFor("<html><title>Hello</title><body><p>正文内容在这里。</p></body></html>"),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.title).toBe("Hello");
    expect(outcome.text).toContain("正文内容在这里。");
    expect(outcome.quote).toContain("正文内容在这里。");
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("refuses a non-public address before it fetches anything", async () => {
    let called = false;
    const outcome = await fetchPage({
      url: "http://127.0.0.1:8080/admin",
      fetchImpl: async () => {
        called = true;
        return responseFor("secret");
      },
    });
    expect(called).toBe(false);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid_response");
  });

  it("refuses a redirect that lands on a private address", async () => {
    const outcome = await fetchPage({
      url: "https://example.com/redirect",
      fetchImpl: async () => {
        const response = responseFor("<html><p>x</p></html>");
        Object.defineProperty(response, "url", { value: "http://192.168.1.1/" });
        return response;
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain("非公网地址");
  });

  it("reports an unsupported content type instead of guessing", async () => {
    const outcome = await fetchPage({
      url: "https://example.com/doc.pdf",
      fetchImpl: async () => responseFor("%PDF-1.7", { contentType: "application/pdf" }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid_response");
    expect(outcome.error.message).toContain("application/pdf");
  });

  it("treats an empty page as a failure, not as empty evidence", async () => {
    const outcome = await fetchPage({
      url: "https://example.com/empty",
      fetchImpl: async () => responseFor("<html><body><script>x</script></body></html>"),
    });
    expect(outcome.ok).toBe(false);
  });

  it("marks 5xx retryable and 404 not", async () => {
    const server = await fetchPage({
      url: "https://example.com/a",
      fetchImpl: async () => responseFor("boom", { status: 503 }),
    });
    expect(server.ok).toBe(false);
    if (!server.ok) expect(server.error.retryable).toBe(true);

    const gone = await fetchPage({
      url: "https://example.com/a",
      fetchImpl: async () => responseFor("missing", { status: 404 }),
    });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error.retryable).toBe(false);
  });

  it("times out instead of hanging", async () => {
    const outcome = await fetchPage({
      url: "https://example.com/slow",
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("timeout");
  });
});
