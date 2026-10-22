import { NextRequest } from "next/server";
import { afterEach, describe, expect, test } from "vitest";

import { REQUEST_ID_HEADER } from "@/lib/obs/request-id";
import { proxy } from "@/proxy";

const AUTH_REQUIRED = process.env.AUTH_REQUIRED;

afterEach(() => {
  if (AUTH_REQUIRED === undefined) delete process.env.AUTH_REQUIRED;
  else process.env.AUTH_REQUIRED = AUTH_REQUIRED;
});

function call(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), { headers });
}

describe("correlation at the edge", () => {
  test("mints an identifier and forwards it downstream", () => {
    const response = proxy(call("/api/today"));

    const forwarded = response.headers.get(
      `x-middleware-request-${REQUEST_ID_HEADER}`,
    );
    expect(forwarded).toMatch(/^r_[0-9a-f]{16}$/);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(forwarded);
  });

  test("keeps a valid identifier so the RSC hop stays on one trace", () => {
    const response = proxy(
      call("/api/today", { [REQUEST_ID_HEADER]: "r_0123456789abcdef" }),
    );

    expect(
      response.headers.get(`x-middleware-request-${REQUEST_ID_HEADER}`),
    ).toBe("r_0123456789abcdef");
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("r_0123456789abcdef");
  });

  test("replaces a caller-supplied identifier it cannot trust", () => {
    // `Headers` already refuses CR/LF, so what is left to defend against is a
    // value that would pollute the log line or blow up a label's cardinality.
    const response = proxy(
      call("/api/today", { [REQUEST_ID_HEADER]: "x".repeat(200) }),
    );

    const forwarded = response.headers.get(
      `x-middleware-request-${REQUEST_ID_HEADER}`,
    );
    expect(forwarded).toMatch(/^r_[0-9a-f]{16}$/);

    const spaced = proxy(
      call("/api/today", { [REQUEST_ID_HEADER]: "not a valid identifier" }),
    );
    expect(
      spaced.headers.get(`x-middleware-request-${REQUEST_ID_HEADER}`),
    ).toMatch(/^r_[0-9a-f]{16}$/);
  });

  test("publishes the path and method the Node runtime cannot otherwise see", () => {
    const response = proxy(call("/api/tasks/tsk_ab12cd34/run", { origin: "x" }));

    expect(
      response.headers.get("x-middleware-request-x-request-path"),
    ).toBe("/api/tasks/tsk_ab12cd34/run");
    expect(
      response.headers.get("x-middleware-request-x-request-method"),
    ).toBe("GET");
  });

  test("health is reachable without a session", () => {
    process.env.AUTH_REQUIRED = "true";

    const response = proxy(call("/api/health?deep=1"));
    expect(response.status).toBe(200);
    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(/^r_/);
  });

  test("an unauthenticated API call is refused with the same identifier", () => {
    process.env.AUTH_REQUIRED = "true";

    const response = proxy(call("/api/today"));
    expect(response.status).toBe(401);
    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(/^r_/);
  });

  test("an unauthenticated page is redirected to login", () => {
    process.env.AUTH_REQUIRED = "true";

    const response = proxy(call("/cabinet"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login?next=%2Fcabinet");
    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(/^r_/);
  });
});
