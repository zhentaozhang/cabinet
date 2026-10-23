import type { ConnectorError, SearchHit } from "./types";

/**
 * A page fetch, as opposed to a search.
 *
 * Search returns snippets chosen by the provider; this returns the body of one
 * URL the task itself named. Both end up as `evidence` rows because both are
 * something a reader can check.
 */
export type PageOutcome =
  | {
      ok: true;
      url: string;
      title: string;
      text: string;
      quote: string;
      latencyMs: number;
    }
  | { ok: false; error: ConnectorError; latencyMs: number };

/** Bodies are for quoting, not for archiving: 2 MiB is generous for an article. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Extracted text is truncated to this many characters before it is stored. */
const MAX_TEXT_CHARS = 4_000;
const MAX_QUOTE_CHARS = 300;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * The first absolute http(s) URL in a string, with trailing punctuation
 * stripped. Tasks are prose, so the URL is usually written inline.
 */
export function extractFirstUrl(text: string): string | null {
  const match = /https?:\/\/[^\s<>"'`]+/i.exec(text);
  if (!match) return null;
  const trimmed = match[0].replace(/[.,;:!?)\]}>）】」。]+$/u, "");
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Refuse addresses that are not on the public internet.
 *
 * This is a literal-host check, not a DNS-resolved one: it stops `localhost`,
 * `127.0.0.1`, `.local` names and RFC1918 literals, but a hostname that
 * *resolves* to a private address would still get through. Resolving here would
 * need a second DNS stack and would still be racy, so the honest framing is:
 * the fetch runs with the same trust the task author already has, and the only
 * thing this guard guarantees is that a typo cannot reach the local machine.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "" || host === "localhost" || host === "0.0.0.0") return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

/** HTML → readable text. Deliberately coarse: no parser, no scripts, no styles. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|section|article|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/** The main content region when the page marks one, else the whole document. */
function mainRegion(html: string): string {
  const article = /<article\b[^>]*>[\s\S]*?<\/article>/i.exec(html);
  if (article) return article[0];
  const main = /<main\b[^>]*>[\s\S]*?<\/main>/i.exec(html);
  if (main) return main[0];
  return html;
}

/**
 * Readable prose, preferring paragraphs over whatever the chrome says.
 *
 * A quote taken from the top of `<body>` is usually navigation ("Jump to
 * content, Main menu"); a quote taken from the first real paragraph is
 * something a reader can match against the page.
 */
export function articleText(html: string): string {
  const region = mainRegion(html);
  const paragraphs = [...region.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => htmlToText(match[1]).replace(/\s+/g, " ").trim())
    .filter((text) => text.length >= 40);
  if (paragraphs.length > 0) {
    return paragraphs.join("\n\n").slice(0, MAX_TEXT_CHARS);
  }
  return htmlToText(region).slice(0, MAX_TEXT_CHARS);
}

/** `<title>` of a page, or the host when there is none. */
export function pageTitle(html: string, url: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = match ? htmlToText(match[1]).replace(/\s+/g, " ").trim() : "";
  if (raw.length > 0) return raw.slice(0, 200);
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A quote a reader can match against the page: the first paragraph of text. */
export function firstQuote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_QUOTE_CHARS) return flat;
  const cut = flat.slice(0, MAX_QUOTE_CHARS);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 120 ? cut.slice(0, boundary) : cut).trim()}…`;
}

async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const body = response.body;
  if (!body) {
    const text = await response.text();
    return text.length > maxBytes ? null : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

/** Fetch one URL and reduce it to a title, text and quotable sentence. */
export async function fetchPage(input: {
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<PageOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const startedAt = Date.now();

  let target: URL;
  try {
    target = new URL(input.url);
  } catch {
    return {
      ok: false,
      latencyMs: 0,
      error: {
        code: "invalid_response",
        message: `不是一个合法的 URL：${input.url}`,
        retryable: false,
      },
    };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return {
      ok: false,
      latencyMs: 0,
      error: {
        code: "invalid_response",
        message: `只支持 http/https，收到 ${target.protocol}`,
        retryable: false,
      },
    };
  }
  if (isBlockedHost(target.hostname)) {
    return {
      ok: false,
      latencyMs: 0,
      error: {
        code: "invalid_response",
        message: `${target.hostname} 不是公网地址，已拒绝抓取。`,
        retryable: false,
      },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(target.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "CabinetEvidenceBot/1.0 (+https://github.com/cabinet-demo)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
      },
    });

    // A redirect may land somewhere the first hop was not allowed to reach.
    const finalUrl = response.url || target.toString();
    try {
      if (isBlockedHost(new URL(finalUrl).hostname)) {
        await response.body?.cancel().catch(() => undefined);
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: {
            code: "invalid_response",
            message: `重定向到了非公网地址 ${finalUrl}，已拒绝。`,
            retryable: false,
          },
        };
      }
    } catch {
      // An unparseable final URL is not something to trust either.
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: {
          code: "invalid_response",
          message: `重定向目标无法解析：${finalUrl}`,
          retryable: false,
        },
      };
    }

    if (!response.ok) {
      await readCapped(response, MAX_BODY_BYTES).catch(() => null);
      const retryable = response.status === 429 || response.status >= 500;
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: {
          code:
            response.status === 429
              ? "rate_limited"
              : response.status >= 500
                ? "network_error"
                : "invalid_response",
          message: `抓取 ${finalUrl} 返回 HTTP ${response.status}。`,
          retryable,
        },
      };
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const readable =
      contentType === "" ||
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml") ||
      contentType.includes("text/plain");
    if (!readable) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: {
          code: "invalid_response",
          message: `只抓取 HTML/文本页面，对方返回 ${contentType}。`,
          retryable: false,
        },
      };
    }

    const raw = await readCapped(response, MAX_BODY_BYTES);
    const latencyMs = Date.now() - startedAt;
    if (raw === null) {
      return {
        ok: false,
        latencyMs,
        error: {
          code: "invalid_response",
          message: `页面超过 ${Math.round(MAX_BODY_BYTES / 1024)} KiB 上限，已放弃。`,
          retryable: false,
        },
      };
    }

    const isHtml = contentType.includes("html") || /<html[\s>]/i.test(raw);
    const text = isHtml ? articleText(raw) : raw.trim().slice(0, MAX_TEXT_CHARS);
    if (text.length === 0) {
      return {
        ok: false,
        latencyMs,
        error: {
          code: "invalid_response",
          message: "抓取成功，但页面没有可读正文（可能需要登录或依赖脚本渲染）。",
          retryable: false,
        },
      };
    }

    return {
      ok: true,
      url: finalUrl,
      title: isHtml ? pageTitle(raw, finalUrl) : new URL(finalUrl).host,
      text,
      quote: firstQuote(text),
      latencyMs,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const aborted =
      error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    return {
      ok: false,
      latencyMs,
      error: aborted
        ? {
            code: "timeout",
            message: `抓取 ${target.hostname} 超时（${Math.round((input.timeoutMs ?? FETCH_TIMEOUT_MS) / 1000)}s）。`,
            retryable: true,
          }
        : {
            code: "network_error",
            message: `抓取 ${target.hostname} 失败：${error instanceof Error ? error.message : "未知错误"}`,
            retryable: true,
          },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The persisted shape of a fetched page, for callers that only need a hit. */
export function pageHit(outcome: Extract<PageOutcome, { ok: true }>): SearchHit {
  return {
    url: outcome.url,
    title: outcome.title,
    quote: outcome.quote,
    publisher: (() => {
      try {
        return new URL(outcome.url).host.replace(/^www\./, "");
      } catch {
        return outcome.url;
      }
    })(),
  };
}
