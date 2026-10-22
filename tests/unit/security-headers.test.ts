import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

async function headerMap(): Promise<Record<string, string>> {
  if (typeof nextConfig.headers !== "function") {
    throw new Error("next.config.ts must declare headers()");
  }
  const rules = await nextConfig.headers();
  const first = rules[0];
  return Object.fromEntries(first.headers.map((h) => [h.key, h.value]));
}

describe("security headers", () => {
  it("sets baseline headers on every route", async () => {
    const headers = await headerMap();

    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
  });
});
