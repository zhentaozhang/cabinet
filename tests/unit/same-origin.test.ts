import { describe, expect, it } from "vitest";

import { assertSameOrigin } from "@/lib/api/mutation";
import { ForbiddenError } from "@/lib/domain/errors";

function request(headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/test", {
    method: "POST",
    headers,
  });
}

describe("same-origin check", () => {
  it("accepts a request without Origin or Sec-Fetch-Site (non-browser client)", () => {
    expect(() => assertSameOrigin(request({}))).not.toThrow();
  });

  it("blocks a cross-site request that omitted Origin", () => {
    expect(() =>
      assertSameOrigin(request({ "sec-fetch-site": "cross-site" })),
    ).toThrow(ForbiddenError);
  });

  it("accepts the configured origin", () => {
    expect(() =>
      assertSameOrigin(
        request({
          origin: "http://localhost:3000",
          host: "localhost:3000",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).not.toThrow();
  });

  it("blocks an unexpected origin", () => {
    expect(() =>
      assertSameOrigin(
        request({
          origin: "https://evil.example",
          host: "localhost:3000",
        }),
      ),
    ).toThrow(ForbiddenError);
  });
});
