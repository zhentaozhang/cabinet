import { describe, expect, it, vi } from "vitest";

import {
  DNS_TIMEOUT_MS,
  checkHostSafety,
  fetchPage,
  isBlockedHost,
  isPrivateAddress,
  resolvesToPrivateAddress,
} from "@/lib/connectors/page";

type LookupImpl = typeof import("node:dns/promises").lookup;

/** Offline DNS: a public answer, so no test resolves a real name. */
const publicLookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupImpl;

/**
 * Wildcard-DNS semantics, as `127.0.0.1.nip.io` actually behaves: the leading
 * dotted quad in the name is the answer. Falls back to a public address.
 */
const nipLikeLookup = (async (hostname: string) => {
  const match = /((?:\d{1,3}\.){3}\d{1,3})/.exec(hostname);
  return [{ address: match ? match[1] : "93.184.216.34", family: 4 }];
}) as unknown as LookupImpl;

function responseFor(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/** A fetch stand-in that records whether anything was dialled at all. */
function fetchSpy(body = "<html><title>T</title><body><p>正文内容足够长，可以引用。</p></body></html>") {
  return vi.fn(async () => responseFor(body));
}

describe("IP literal normalisation", () => {
  it("blocks every numeric spelling of loopback", () => {
    for (const host of [
      "2130706433",
      "0x7f.0.0.1",
      "0x7F000001",
      "0177.0.0.1",
      "127.1",
      "127.0.0.1",
      "0x7f000001",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "[::ffff:127.0.0.1]",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "[::]",
      "localhost",
    ]) {
      expect(isBlockedHost(host), host).toBe(true);
    }
  });

  it("classifies private literals in every notation", () => {
    for (const host of [
      "10.1.2.3",
      "167772161", // 10.0.0.1
      "0x0a.0.0.1",
      "012.0.0.1", // 10.0.0.1
      "0254.16.0.1", // 172.16.0.1
      "169.254.169.254",
      "172.16.5.4",
      "172.31.255.255",
      "192.168.0.1",
      "100.64.0.1",
      "224.0.0.1",
      "0.0.0.0",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "[::ffff:10.0.0.1]",
      "::ffff:7f00:1",
    ]) {
      expect(isPrivateAddress(host), host).toBe(true);
    }
  });

  it("keeps public literals and ordinary names public", () => {
    for (const host of [
      "8.8.8.8",
      "93.184.216.34",
      "134744072", // 8.8.8.8
      "0x08080808",
      "010.1.2.3", // octal 010 is 8, so this is the public 8.1.2.3
      "2606:4700:4700::1111",
      "example.com",
      "fda.gov",
      "127.0.0.1.nip.io",
    ]) {
      expect(isBlockedHost(host), host).toBe(false);
    }
  });
});

describe("fetchPage SSRF guard", () => {
  it("refuses every literal spelling of loopback before dialling", async () => {
    for (const url of [
      "http://2130706433/",
      "http://0x7f.0.0.1/",
      "http://0177.0.0.1/",
      "http://127.1/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::1]/",
      "http://localhost/",
      "http://127.0.0.1.nip.io/",
      "http://0x7f000001/",
      "http://[::]/",
      // Userinfo is not the host: the request still goes to 127.0.0.1.
      "http://example.com@127.0.0.1/",
    ]) {
      const fetchImpl = fetchSpy();
      const outcome = await fetchPage({
        url,
        lookupImpl: nipLikeLookup,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(outcome.ok, url).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.error.code, url).toBe("invalid_response");
      expect(outcome.error.message, url).toContain("不是公网地址");
      expect(fetchImpl, url).not.toHaveBeenCalled();
    }
  });

  it("refuses a host whose DNS answer is private", async () => {
    const fetchImpl = fetchSpy();
    const outcome = await fetchPage({
      url: "https://evil.example/page",
      lookupImpl: (async () => [{ address: "10.0.0.5", family: 4 }]) as unknown as LookupImpl,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid_response");
    expect(outcome.error.message).toContain("不是公网地址");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lets ordinary public URLs through", async () => {
    for (const url of ["https://example.com/x", "http://fda.gov/"]) {
      const outcome = await fetchPage({
        url,
        lookupImpl: publicLookup,
        fetchImpl: fetchSpy() as unknown as typeof fetch,
      });
      expect(outcome.ok, url).toBe(true);
      if (outcome.ok) expect(outcome.text).toContain("正文内容");
    }
  });

  it("refuses schemes other than http and https", async () => {
    for (const url of ["file:///etc/passwd", "gopher://x/1"]) {
      const fetchImpl = fetchSpy();
      const outcome = await fetchPage({
        url,
        lookupImpl: publicLookup,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(outcome.ok, url).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.error.code, url).toBe("invalid_response");
      expect(outcome.error.message, url).toContain("只支持 http/https");
      expect(outcome.error.retryable, url).toBe(false);
      expect(fetchImpl, url).not.toHaveBeenCalled();
    }
  });

  it("still refuses when DNS never answers, after a bounded retry", async () => {
    const never = vi.fn(
      () => new Promise<never>(() => undefined),
    ) as unknown as LookupImpl;
    const fetchImpl = fetchSpy();
    const startedAt = Date.now();
    const outcome = await fetchPage({
      url: "https://slow-dns.example/page",
      lookupImpl: never,
      dnsTimeoutMs: 25,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const elapsed = Date.now() - startedAt;

    expect(DNS_TIMEOUT_MS).toBe(3_000);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("timeout");
    expect(outcome.error.message).toContain("解析超时");
    expect(outcome.error.message).toContain("已拒绝");
    expect(fetchImpl).not.toHaveBeenCalled();
    // One retry, so the timeout budget is spent twice and then we give up.
    expect(never).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("reports a DNS timeout differently from a private answer", async () => {
    const timedOut = await checkHostSafety("slow-dns.example", {
      lookupImpl: (() => new Promise<never>(() => undefined)) as unknown as LookupImpl,
      timeoutMs: 20,
    });
    const privateAnswer = await checkHostSafety("evil.example", {
      lookupImpl: (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupImpl,
    });
    const unresolvable = await checkHostSafety("nope.example", {
      lookupImpl: (async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND nope.example"), { code: "ENOTFOUND" });
      }) as unknown as LookupImpl,
    });

    expect(timedOut.safe).toBe(false);
    expect(privateAnswer.safe).toBe(false);
    expect(unresolvable.safe).toBe(false);
    if (timedOut.safe || privateAnswer.safe || unresolvable.safe) return;
    expect(timedOut.reason).toBe("dns_timeout");
    expect(privateAnswer.reason).toBe("private_answer");
    expect(unresolvable.reason).toBe("dns_failure");
  });

  it("retries a transient DNS failure instead of calling it an attack", async () => {
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("getaddrinfo EAI_AGAIN slow.example"), { code: "EAI_AGAIN" });
      }
      return [{ address: "93.184.216.34", family: 4 }];
    }) as unknown as LookupImpl;

    const outcome = await fetchPage({
      url: "https://slow.example/page",
      lookupImpl: flaky,
      fetchImpl: fetchSpy() as unknown as typeof fetch,
    });
    expect(calls).toBe(2);
    expect(outcome.ok).toBe(true);
  });

  it("fails closed when DNS cannot resolve at all", async () => {
    const fetchImpl = fetchSpy();
    const outcome = await fetchPage({
      url: "https://nope.example/page",
      lookupImpl: (async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND nope.example"), { code: "ENOTFOUND" });
      }) as unknown as LookupImpl,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("network_error");
    expect(outcome.error.message).toContain("解析");
    expect(outcome.error.message).toContain("已拒绝");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-checks SSRF safety on every redirect hop", async () => {
    const literalHop = await fetchPage({
      url: "https://example.com/redirect",
      lookupImpl: publicLookup,
      fetchImpl: (async () =>
        new Response(null, { status: 302, headers: { location: "http://10.0.0.1/admin" } })
      ) as unknown as typeof fetch,
    });
    expect(literalHop.ok).toBe(false);
    if (literalHop.ok) return;
    expect(literalHop.error.message).toContain("非公网地址");

    // A redirect to a name that only resolves privately must be caught too.
    const namedHop = await fetchPage({
      url: "https://example.com/redirect",
      lookupImpl: nipLikeLookup,
      fetchImpl: (async () =>
        new Response(null, { status: 307, headers: { location: "http://internal.127.0.0.1.nip.io/" } })
      ) as unknown as typeof fetch,
    });
    expect(namedHop.ok).toBe(false);
    if (namedHop.ok) return;
    expect(namedHop.error.message).toContain("非公网地址");
  });

  it("refuses a redirect to a name whose DNS never answers", async () => {
    const lookup = (async (hostname: string) =>
      hostname === "slow.example"
        ? new Promise<never>(() => undefined)
        : [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupImpl;
    const startedAt = Date.now();
    const outcome = await fetchPage({
      url: "https://example.com/redirect",
      lookupImpl: lookup,
      dnsTimeoutMs: 30,
      fetchImpl: (async () =>
        new Response(null, { status: 302, headers: { location: "http://slow.example/admin" } })
      ) as unknown as typeof fetch,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain("重定向目标");
    expect(outcome.error.message).toContain("已拒绝");
    // Bounded by the shared budget: one hop cannot wait out a fresh timeout each.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("also refuses a redirect that changes scheme to something else", async () => {
    const outcome = await fetchPage({
      url: "https://example.com/redirect",
      lookupImpl: publicLookup,
      fetchImpl: (async () =>
        new Response(null, { status: 301, headers: { location: "file:///etc/passwd" } })
      ) as unknown as typeof fetch,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain("非 http(s)");
  });

  it("keeps the boolean helper for callers that only need a verdict", async () => {
    await expect(resolvesToPrivateAddress("evil.example", (async () => [
      { address: "192.168.1.1", family: 4 },
    ]) as unknown as LookupImpl)).resolves.toBe(true);
    await expect(
      resolvesToPrivateAddress("example.com", publicLookup),
    ).resolves.toBe(false);
  });
});
