import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ERROR_CODE_LABEL } from "@/contracts/errors";
import { createApiClient } from "@/lib/api/client";

const client = createApiClient({ baseUrl: "http://api.test" });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(status: number): Response {
  return new Response("<html>boom</html>", {
    status,
    headers: { "content-type": "text/html" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api client transport", () => {
  it("never throws on a non-JSON server error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(500)),
    );

    const result = await client.mutate("/api/x", { method: "POST", body: {} });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("internal_error");
    expect(result.status).toBe(500);
    expect(result.error).toContain("非 JSON");
  });

  it("returns a transport failure instead of hanging when the server stalls", async () => {
    const stalled = createApiClient({
      baseUrl: "http://api.test",
      timeoutMs: 10,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      ),
    );

    const result = await stalled.query("/api/slow", z.object({ a: z.number() }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(0);
    expect(result.error).toContain("超时");
  });

  it("still times out when headers arrive but the body never finishes", async () => {
    // A proxy or a stuck backend can flush `200 OK` and then stall the stream.
    // If the timeout only covered `fetch()`, this call would hang forever and
    // the button that started it would stay busy with no way to recover.
    const stalled = createApiClient({
      baseUrl: "http://api.test",
      timeoutMs: 20,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"ok":true,'));
            // Headers are already flushed; the rest of the body never arrives.
            init.signal?.addEventListener("abort", () => {
              stream.error(new DOMException("aborted", "AbortError"));
            });
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const result = await stalled.query("/api/half", z.object({ a: z.number() }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("超时");
  });

  it("reports a truncated body as a bad response, not as a timeout", async () => {
    // Headers arrive, the body ends early, and no timer ever fires: this is a
    // broken response and must not be blamed on the network.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"ok":true,', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const result = await client.query("/api/truncated", z.object({ a: z.number() }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain("超时");
    expect(result.error).toContain("非 JSON");
  });
});

describe("api client envelope", () => {
  it("unwraps the { ok, data } envelope for reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, data: { count: 3 } })),
    );

    const result = await client.query(
      "/api/read",
      z.object({ count: z.number() }),
    );

    expect(result).toEqual({ ok: true, data: { count: 3 } });
  });

  it("unwraps writes the same way reads are unwrapped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, data: { decision: "accepted" } })),
    );

    const result = await client.mutate<Record<string, unknown>>("/api/write", {
      method: "POST",
      body: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One shape on the wire: `{ok:true,data}` for reads and writes alike.
    expect(result.data).toEqual({ decision: "accepted" });
  });

  it("can still read a flat body when a caller asks for it explicitly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, data: "not-a-envelope" })),
    );

    const result = await client.mutate<Record<string, unknown>>("/api/legacy", {
      method: "POST",
      body: {},
      envelope: "flat",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ ok: true, data: "not-a-envelope" });
  });

  it("surfaces the transport code of a typed failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { ok: false, error: "超出预算", code: "policy_denied" },
          403,
        ),
      ),
    );

    const result = await client.mutate("/api/policy", { method: "POST" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("policy_denied");
    expect(result.error).toBe("超出预算");
  });

  it("reports a contract violation as a 502 instead of a wrong shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, data: { count: "three" } })),
    );

    const result = await client.query(
      "/api/read",
      z.object({ count: z.number() }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(result.error).toContain("不符合契约");
  });
});

describe("idempotency keys", () => {
  function recordKeys(): string[] {
    const keys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        keys.push(new Headers(init.headers).get("idempotency-key") ?? "");
        return jsonResponse({ ok: true, accepted: true });
      }),
    );
    return keys;
  }

  it("reuses the key after a transport failure, then releases it on success", async () => {
    const keys: string[] = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        call += 1;
        keys.push(new Headers(init.headers).get("idempotency-key") ?? "");
        if (call === 1) throw new TypeError("network down");
        return jsonResponse({ ok: true, accepted: true });
      }),
    );

    const first = await client.mutate("/api/run", { method: "POST", body: {} });
    expect(first.ok).toBe(false);

    const retry = await client.mutate("/api/run", { method: "POST", body: {} });
    expect(retry.ok).toBe(true);

    // Same intent -> same key, so the server can deduplicate the retry.
    expect(keys[1]).toBe(keys[0]);

    // A completed intent releases the key: the next click is a new intent.
    await client.mutate("/api/run", { method: "POST", body: {} });
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("gives every fresh click its own key", async () => {
    const keys = recordKeys();

    await client.mutate("/api/ok", { method: "POST", body: { a: 1 } });
    await client.mutate("/api/ok", { method: "POST", body: { a: 1 } });

    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("error copy", () => {
  it("replaces an English placeholder with the code's own sentence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ ok: false, error: "Internal error", code: "internal_error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const client = createApiClient({ baseUrl: "http://x" });

    const result = await client.request("/api/x");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(ERROR_CODE_LABEL.internal_error);
    expect(result.error).not.toContain("Internal");
  });

  it("keeps a message the server wrote on purpose", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ ok: false, error: "本周预算已用尽", code: "policy_denied" }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const client = createApiClient({ baseUrl: "http://x" });

    const result = await client.request("/api/x");
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("本周预算已用尽");
  });
});
