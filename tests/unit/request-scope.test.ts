import { describe, expect, it } from "vitest";

import {
  currentRequestId,
  inboundRequestId,
  runWithRequestScope,
} from "@/lib/observability/context";

describe("request scope", () => {
  it("keeps a well-formed inbound id", () => {
    const request = new Request("http://x", {
      headers: { "x-request-id": "trace-1234.abcd" },
    });
    expect(inboundRequestId(request)).toBe("trace-1234.abcd");
  });

  it("rejects an id that is too long or carries other characters", () => {
    const long = new Request("http://x", {
      headers: { "x-request-id": "a".repeat(65) },
    });
    const weird = new Request("http://x", {
      headers: { "x-request-id": "id with spaces" },
    });
    expect(inboundRequestId(long)).toBeNull();
    expect(inboundRequestId(weird)).toBeNull();
  });

  it("mints an id when the caller did not send one", async () => {
    const request = new Request("http://x");
    let seen: string | null = null;
    const { requestId } = await runWithRequestScope(request, async () => {
      seen = currentRequestId();
      return "done";
    });
    expect(seen).toBe(requestId);
    expect(requestId).toMatch(/^req_[a-z0-9]{20}$/);
  });

  it("scopes the id to the request and hides it outside", async () => {
    await runWithRequestScope(new Request("http://x"), async () => {
      expect(currentRequestId()).not.toBeNull();
    });
    expect(currentRequestId()).toBeNull();
  });
});
