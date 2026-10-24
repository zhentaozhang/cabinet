import { lookup } from "node:dns/promises";
import { readTextCapped } from "./http";
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
 * DNS lookups get their own budget, separate from the body fetch.
 *
 * A resolver that is merely slow — overseas names such as `fda.gov` are — must
 * not be reported as an attack, so the wait is generous and one failed attempt is
 * retried. This is deliberately **not** fail-open: a lookup that never answers is
 * still refused, because an attacker who controls DNS can answer slowly for the
 * check and promptly for the fetch, which is the rebinding race below.
 */
export const DNS_TIMEOUT_MS = 3_000;
/** One retry: enough to ride out a cold or flaky resolver, small enough to bound the wait. */
const DNS_ATTEMPTS = 2;

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

/** Redirects are followed by hand so every hop can be checked. */
const MAX_REDIRECTS = 3;

/** `[::1]`, `[::ffff:7f00:1]` and `127.0.0.1` differ only in decoration. */
function bareHost(hostname: string): string {
  const bare = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  // A zone index (`fe80::1%eth0`) is not part of the address.
  const zone = bare.indexOf("%");
  return zone >= 0 ? bare.slice(0, zone) : bare;
}

/** One octet group, where a leading `0` means octal and `0x` means hex. */
function parseIpv4Group(group: string): number | null {
  if (group === "") return null;
  let digits = group;
  let radix = 10;
  if (group.length > 1 && group.startsWith("0x")) {
    radix = 16;
    digits = group.slice(2);
  } else if (group.length > 1 && group.startsWith("0")) {
    radix = 8;
    digits = group.slice(1);
  }
  const pattern = radix === 16 ? /^[0-9a-f]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!pattern.test(digits)) return null;
  const value = Number.parseInt(digits, radix);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * An IPv4 address in any of the spellings `inet_aton` accepts.
 *
 * The URL parser folds most of these itself, but the guard is also called with
 * raw strings, so it must read `2130706433`, `0x7f.0.0.1`, `0177.0.0.1` and the
 * short form `127.1` without relying on that. Returns null for anything that is
 * not a literal, which is how a hostname stays a hostname.
 */
export function parseIpv4(host: string): number[] | null {
  const text = bareHost(host);
  if (text === "") return null;
  const raw = text.split(".");
  // A trailing dot is the root label, not an empty octet.
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
  if (raw.length > 4) return null;
  const groups: number[] = [];
  for (const group of raw) {
    const value = parseIpv4Group(group);
    if (value === null) return null;
    groups.push(value);
  }
  // `inet_aton` lets the final group absorb the remaining bytes: `127.1` is
  // 127.0.0.1 and `2130706433` is a whole address.
  const head = groups.slice(0, -1);
  const last = groups[groups.length - 1];
  const tailBytes = 4 - head.length;
  if (head.some((value) => value > 255)) return null;
  if (last >= 2 ** (8 * tailBytes)) return null;
  const bytes = [...head];
  for (let shift = tailBytes - 1; shift >= 0; shift -= 1) {
    bytes.push((last >>> (8 * shift)) & 0xff);
  }
  return bytes;
}

/**
 * An IPv6 address as 16 bytes, including the forms that hide an IPv4 address.
 *
 * `::ffff:127.0.0.1` and `::ffff:7f00:1` are the same address, and the URL
 * parser rewrites the first into the second — so both spellings must parse.
 */
export function parseIpv6(host: string): number[] | null {
  let text = bareHost(host);
  if (!text.includes(":")) return null;
  // Rewrite a dotted IPv4 tail into two hex groups so one grammar covers both.
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const embedded = parseIpv4(text.slice(lastColon + 1));
    if (!embedded) return null;
    const high = (((embedded[0] << 8) | embedded[1]) >>> 0).toString(16);
    const low = (((embedded[2] << 8) | embedded[3]) >>> 0).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const split = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];
  const groups = [...head, ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  const toValue = (group: string): number => Number.parseInt(group, 16);
  let values: number[];
  if (halves.length === 2) {
    // `::` stands for at least one all-zero group, never for nothing.
    const zeros = 8 - groups.length;
    if (zeros < 1) return null;
    values = [
      ...head.map(toValue),
      ...Array.from({ length: zeros }, () => 0),
      ...tail.map(toValue),
    ];
  } else {
    if (groups.length !== 8) return null;
    values = groups.map(toValue);
  }
  const bytes: number[] = [];
  for (const value of values) bytes.push(value >> 8, value & 0xff);
  return bytes;
}

/** The IPv4 ranges that are not public unicast. */
function isPrivateIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
}

/** Non-public IPv6 ranges, including the IPv4 addresses some of them embed. */
function isPrivateIpv6(bytes: number[]): boolean {
  const zeros = (start: number, end: number): boolean =>
    bytes.slice(start, end).every((byte) => byte === 0);
  const embedded = (offset: number): boolean =>
    isPrivateIpv4(bytes.slice(offset, offset + 4));
  // ::/96: unspecified, loopback, and the deprecated IPv4-compatible form.
  if (zeros(0, 12)) return true;
  // ::ffff:0:0/96 IPv4-mapped (::ffff:127.0.0.1 and ::ffff:7f00:1 alike).
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return embedded(12);
  // 64:ff9b::/96 NAT64 and 2002::/16 6to4 carry an IPv4 address in plain sight.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    if (zeros(4, 12)) return embedded(12);
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return embedded(2);
  // fe80::/10 link-local, fec0::/10 site-local.
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true;
  // fc00::/7 unique-local, ff00::/8 multicast.
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xff) return true;
  return false;
}

/**
 * True for anything that is not a public unicast address.
 *
 * Literals are normalised first, so every spelling of one address gets one
 * verdict: loopback, RFC1918, link-local, CGNAT, multicast/reserved, plus the
 * IPv6 forms a naive parser misses (`::1`, `fc00::/7`, `::ffff:127.0.0.1`).
 * Input that is not a literal at all is not decided here — it has to be
 * resolved, which is `checkHostSafety`'s job.
 */
export function isPrivateAddress(address: string): boolean {
  const host = bareHost(address);
  if (host === "") return true;
  const v6 = parseIpv6(host);
  if (v6) return isPrivateIpv6(v6);
  const v4 = parseIpv4(host);
  if (v4) return isPrivateIpv4(v4);
  return false;
}

/** Literal-host check: names that cannot be public however they resolve. */
export function isBlockedHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (host === "" || host === "localhost" || host === "0.0.0.0") return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  // Only literals are judged here. A bare `startsWith("fc")` test used to live
  // in this function and refused `fda.gov` for looking like a `fc00::/7`
  // address; a name is never a prefix match against an IPv6 range.
  return isPrivateAddress(host);
}

/** Why a host was refused, kept apart so logs can tell slow DNS from an attack. */
export type HostSafetyReason = "blocked_literal" | "private_answer" | "dns_timeout" | "dns_failure";

export type HostSafety =
  | { safe: true; hostname: string; addresses: string[] }
  | {
      safe: false;
      hostname: string;
      reason: HostSafetyReason;
      /** The offending answers, when the reason came from a lookup. */
      addresses: string[];
      /** Operator-facing detail: the timeout value, or the resolver's error. */
      detail: string;
    };

type LookupAttempt =
  | { ok: true; addresses: string[] }
  | { ok: false; timedOut: boolean; detail: string };

/** One lookup, bounded: a resolver that never answers must not hang the task. */
async function lookupOnce(
  hostname: string,
  dnsLookup: typeof lookup,
  timeoutMs: number,
): Promise<LookupAttempt> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`DNS lookup for ${hostname} exceeded ${timeoutMs}ms`);
      error.name = "DnsTimeoutError";
      reject(error);
    }, timeoutMs);
  });
  try {
    const records = await Promise.race([
      dnsLookup(hostname, { all: true, verbatim: true }),
      deadline,
    ]);
    return { ok: true, addresses: records.map((record) => record.address) };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "DnsTimeoutError";
    return {
      ok: false,
      timedOut,
      detail:
        "code" in Object(error)
          ? `${(error as { code?: string }).code ?? ""} ${error instanceof Error ? error.message : ""}`.trim()
          : error instanceof Error
            ? error.message
            : "未知解析错误",
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Refuse a host that is, or resolves to, a non-public address.
 *
 * Checking the URL text alone lets `evil.example → 127.0.0.1` through, which is
 * the classic SSRF shape. This resolves first and refuses when any answer is
 * private. A private answer is refused at once — retrying it would only give a
 * rebinding server a second chance to say something public.
 *
 * Residual risk, stated rather than hidden: the fetch resolves the name again,
 * so a DNS server that changes its answer between the two lookups (rebinding)
 * can still win the race; closing that needs a dialer pinned to the checked IP,
 * which the fetch API does not expose.
 *
 * A lookup that times out or fails is a refusal too, never a pass: with the
 * generous timeout and the single retry, a healthy public name is not caught by
 * it, while a name the attacker keeps unresolved cannot slip through.
 */
export async function checkHostSafety(
  hostname: string,
  options: {
    lookupImpl?: typeof lookup;
    /** Overridable so tests never wait out the real budget. */
    timeoutMs?: number;
    attempts?: number;
  } = {},
): Promise<HostSafety> {
  if (isBlockedHost(hostname)) {
    return {
      safe: false,
      hostname,
      reason: "blocked_literal",
      addresses: [],
      detail: "字面量地址不在公网单播范围内",
    };
  }
  const dnsLookup = options.lookupImpl ?? lookup;
  const timeoutMs = options.timeoutMs ?? DNS_TIMEOUT_MS;
  const attempts = Math.max(1, options.attempts ?? DNS_ATTEMPTS);

  let last: Extract<LookupAttempt, { ok: false }> = {
    ok: false,
    timedOut: false,
    detail: "未尝试解析",
  };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await lookupOnce(hostname, dnsLookup, timeoutMs);
    if (result.ok) {
      if (result.addresses.length === 0) {
        last = { ok: false, timedOut: false, detail: "解析结果为空" };
        continue;
      }
      const privateAnswers = result.addresses.filter((address) => isPrivateAddress(address));
      if (privateAnswers.length > 0) {
        return {
          safe: false,
          hostname,
          reason: "private_answer",
          addresses: privateAnswers,
          detail: `解析到 ${privateAnswers.join(", ")}`,
        };
      }
      return { safe: true, hostname, addresses: result.addresses };
    }
    last = result;
  }

  return last.timedOut
    ? {
        safe: false,
        hostname,
        reason: "dns_timeout",
        addresses: [],
        detail: `每 ${timeoutMs}ms 超时，已尝试 ${attempts} 次`,
      }
    : {
        safe: false,
        hostname,
        reason: "dns_failure",
        addresses: [],
        detail: `${last.detail}（已尝试 ${attempts} 次）`,
      };
}

/** The boolean shape kept for callers that only need a verdict. */
export async function resolvesToPrivateAddress(
  hostname: string,
  dnsLookup: typeof lookup = lookup,
): Promise<boolean> {
  const verdict = await checkHostSafety(hostname, { lookupImpl: dnsLookup });
  return !verdict.safe;
}

/** One refusal, in the connector's own vocabulary. */
function hostSafetyError(verdict: Extract<HostSafety, { safe: false }>, target: URL): ConnectorError {
  switch (verdict.reason) {
    case "blocked_literal":
    case "private_answer":
      return {
        code: "invalid_response",
        retryable: false,
        message: `${target.hostname} 不是公网地址（或在 DNS 中解析到私网），已拒绝抓取。`,
      };
    case "dns_timeout":
      return {
        code: "timeout",
        retryable: true,
        message: `${target.hostname} 解析超时：${verdict.detail}，已拒绝抓取。`,
      };
    case "dns_failure":
      return {
        code: "network_error",
        retryable: true,
        message: `${target.hostname} 解析失败：${verdict.detail}，无法确认是公网地址，已拒绝抓取。`,
      };
  }
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


/** Fetch one URL and reduce it to a title, text and quotable sentence. */
export async function fetchPage(input: {
  url: string;
  fetchImpl?: typeof fetch;
  /** Injected DNS resolver, so tests never touch the network. */
  lookupImpl?: typeof lookup;
  timeoutMs?: number;
  /** Overrides `DNS_TIMEOUT_MS` per lookup; tests use it to stay fast. */
  dnsTimeoutMs?: number;
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
  // One DNS budget for the whole call: `timeout + one retry` per lookup, shared
  // by every redirect hop, so a chain of slow names cannot stack a fresh six
  // seconds onto each hop. Exhausting it is still a refusal, never a pass.
  const perLookupDnsMs = input.dnsTimeoutMs ?? DNS_TIMEOUT_MS;
  const dnsDeadlineAt = startedAt + 2 * perLookupDnsMs;
  const checkHost = (hostname: string): Promise<HostSafety> =>
    checkHostSafety(hostname, {
      lookupImpl: input.lookupImpl ?? lookup,
      timeoutMs: Math.max(1, Math.min(perLookupDnsMs, dnsDeadlineAt - Date.now())),
    });

  const checked = await checkHost(target.hostname);
  if (!checked.safe) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: hostSafetyError(checked, target),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    let current = target;
    let hops = 0;
    let response: Response;
    for (;;) {
      response = await fetchImpl(current.toString(), {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "user-agent": "CabinetEvidenceBot/1.0 (+https://github.com/cabinet-demo)",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        },
      });

      const isRedirect = response.status >= 300 && response.status < 400;
      if (!isRedirect) break;

      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: {
            code: "invalid_response",
            message: `重定向缺少 Location 头（HTTP ${response.status}）。`,
            retryable: false,
          },
        };
      }
      if (hops >= MAX_REDIRECTS) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: {
            code: "invalid_response",
            message: `重定向超过 ${MAX_REDIRECTS} 次，已放弃。`,
            retryable: false,
          },
        };
      }
      hops += 1;

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: {
            code: "invalid_response",
            message: `重定向目标无法解析：${location}`,
            retryable: false,
          },
        };
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: {
            code: "invalid_response",
            message: `重定向到了非 http(s) 地址 ${next.toString()}，已拒绝。`,
            retryable: false,
          },
        };
      }
      // Every hop is checked, not just the first and the last: a redirect is the
      // easiest way to turn a public URL into an internal one.
      const hop = await checkHost(next.hostname);
      if (!hop.safe) {
        const refusal = hostSafetyError(hop, next);
        const landedOnInternal =
          hop.reason === "private_answer" || hop.reason === "blocked_literal";
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: landedOnInternal
            ? {
                code: "invalid_response",
                message: `重定向到了非公网地址 ${next.toString()}，已拒绝。`,
                retryable: false,
              }
            : {
                code: refusal.code,
                message: `重定向目标 ${next.toString()}：${hop.detail}，已拒绝。`,
                retryable: refusal.retryable,
              },
        };
      }
      current = next;
    }
    const finalUrl = current.toString();

    if (!response.ok) {
      await readTextCapped(response, MAX_BODY_BYTES).catch(() => null);
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

    const raw = await readTextCapped(response, MAX_BODY_BYTES);
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
