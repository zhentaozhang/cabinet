import { beforeEach, describe, expect, it } from "vitest";
import { withIdempotency } from "@/lib/api/idempotency";
import { DEMO_USER_ID } from "@/lib/demo";
import { ConflictError } from "@/lib/domain/errors";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

function request(body: unknown, key?: string): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("withIdempotency", () => {
  it("replays the first response for the same key and body", async () => {
    let calls = 0;
    const handler = async () => {
      calls += 1;
      return { status: 200, body: { ok: true, calls } };
    };

    const first = await withIdempotency({
      request: request({ value: 1 }, "key-1"),
      userId: DEMO_USER_ID,
      endpoint: "test",
      body: { value: 1 },
      handler,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, calls: 1 });

    const second = await withIdempotency({
      request: request({ value: 1 }, "key-1"),
      userId: DEMO_USER_ID,
      endpoint: "test",
      body: { value: 1 },
      handler,
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual({ ok: true, calls: 1 });
    expect(calls).toBe(1);
  });

  it("rejects the same key with a different body", async () => {
    const handler = async () => ({ status: 200, body: { ok: true } });
    await withIdempotency({
      request: request({ value: 1 }, "key-2"),
      userId: DEMO_USER_ID,
      endpoint: "test",
      body: { value: 1 },
      handler,
    });

    await expect(
      withIdempotency({
        request: request({ value: 2 }, "key-2"),
        userId: DEMO_USER_ID,
        endpoint: "test",
        body: { value: 2 },
        handler,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("executes twice when no key is provided", async () => {
    let calls = 0;
    const handler = async () => {
      calls += 1;
      return { status: 200, body: { ok: true, calls } };
    };

    await withIdempotency({
      request: request({ value: 1 }),
      userId: DEMO_USER_ID,
      endpoint: "test",
      body: { value: 1 },
      handler,
    });
    await withIdempotency({
      request: request({ value: 1 }),
      userId: DEMO_USER_ID,
      endpoint: "test",
      body: { value: 1 },
      handler,
    });
    expect(calls).toBe(2);
  });

  it("does not execute the handler twice under concurrent replay", async () => {
    let calls = 0;
    const handler = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: 200, body: { ok: true, calls } };
    };

    const results = await Promise.allSettled([
      withIdempotency({
        request: request({ value: 1 }, "key-3"),
        userId: DEMO_USER_ID,
        endpoint: "test",
        body: { value: 1 },
        handler,
      }),
      withIdempotency({
        request: request({ value: 1 }, "key-3"),
        userId: DEMO_USER_ID,
        endpoint: "test",
        body: { value: 1 },
        handler,
      }),
    ]);

    expect(calls).toBe(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});
