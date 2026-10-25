import { describe, expect, it } from "vitest";

import {
  maybeContacted,
  statusImpliesContact,
  stepMadeRequest,
} from "@/lib/domain/contact";

describe("stepMadeRequest", () => {
  it("trusts an explicit flag over any status", () => {
    // A not_connected step may come from a tool that was never called
    // (rejected by the plan) or from a call whose socket died after the request
    // left. Only the caller knows which, so the flag wins.
    expect(stepMadeRequest({ status: "not_connected", attempted: true })).toBe(true);
    expect(stepMadeRequest({ status: "ok", attempted: false })).toBe(false);
  });

  it("falls back to the status for rows written before the flag existed", () => {
    for (const status of ["ok", "timeout", "invalid_response", "rate_limited"]) {
      expect(stepMadeRequest({ status })).toBe(true);
    }
    for (const status of ["unauthorized", "budget_exceeded", "not_connected", "skipped"]) {
      expect(stepMadeRequest({ status })).toBe(false);
    }
    expect(stepMadeRequest(null)).toBe(false);
  });

  it("does not treat a provider label as proof of a call", () => {
    // 5f332e7f: provider used to be written on every MCP step, including the
    // ones rejected before the network. It must not decide anything now.
    expect(stepMadeRequest({ provider: "mcp:github" })).toBe(false);
  });
});

describe("status vocabulary", () => {
  it("only counts statuses a remote peer has to produce", () => {
    expect(statusImpliesContact("ok")).toBe(true);
    expect(statusImpliesContact("rate_limited")).toBe(true);
    expect(statusImpliesContact("budget_exceeded")).toBe(false);
  });

  it("treats an attempt followed by a client-side failure as possibly charged", () => {
    expect(maybeContacted("timeout")).toBe(true);
    expect(maybeContacted("network_error")).toBe(true);
    expect(maybeContacted("invalid_response")).toBe(true);
    expect(maybeContacted("rate_limited")).toBe(true);
    expect(maybeContacted("unauthorized")).toBe(false);
    expect(maybeContacted("not_configured")).toBe(false);
  });
});
