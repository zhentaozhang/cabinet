import { describe, expect, it, vi } from "vitest";
import { governedCall, MCP_STATUS_MAP } from "@/server/services/commands/tasks/governed-call";
import type { Grant } from "@/lib/domain/policy";

const readGrant: Grant[] = [{ resource: "mcp:github", scope: "read" }];

function deps(overrides: Record<string, unknown> = {}) {
  const call = vi.fn(async () => ({ ok: true as const, latencyMs: 12, value: "issue created" }));
  const admit = vi.fn(async (_cents: number) => ({ allowed: true as const, reservationId: "brs_1" }));
  const settle = vi.fn(async (_id: string | undefined, _state: string) => {});
  return {
    tool: "mcp:github:search_issues",
    resource: "mcp:github",
    scope: "read" as const,
    grants: readGrant,
    args: { q: "bug" },
    admit,
    settle,
    call,
    ...overrides,
  };
}

describe("governedCall", () => {
  it("refuses an ungranted tool without touching the network", async () => {
    const base = deps({ grants: [{ resource: "mcp:gitlab", scope: "read" }] });
    const result = await governedCall(base);
    expect(result.status).toBe("unauthorized");
    expect(base.call).not.toHaveBeenCalled();
    expect(base.admit).not.toHaveBeenCalled();
  });

  it("does not call when the budget hold is refused", async () => {
    const base = deps({
      admit: vi.fn(async () => ({ allowed: false as const, reason: "本周预算不足" })),
    });
    const result = await governedCall(base);
    expect(result.status).toBe("budget_exceeded");
    expect(result.reason).toContain("预算");
    expect(base.call).not.toHaveBeenCalled();
  });

  it("holds before the call and settles the same reservation after it", async () => {
    const base = deps();
    const result = await governedCall(base);
    expect(result.status).toBe("ok");
    expect(result.content).toBe("issue created");
    expect(base.admit).toHaveBeenCalledWith(0);
    expect(base.settle).toHaveBeenCalledWith("brs_1", "settled");
    expect(base.admit.mock.invocationCallOrder[0]!).toBeLessThan(
      base.call.mock.invocationCallOrder[0]!,
    );
  });

  it("releases the hold when the call throws, so nothing is charged", async () => {
    const base = deps({
      call: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    });
    const result = await governedCall(base);
    expect(result.status).toBe("not_connected");
    expect(base.settle).toHaveBeenCalledWith("brs_1", "released");
  });

  it("charges an unknown amount when the server timed out mid-call", async () => {
    const base = deps({
      call: vi.fn(async () => ({
        ok: false as const,
        latencyMs: 8000,
        error: { code: "timeout" as const, message: "too slow", retryable: true },
      })),
    });
    const result = await governedCall(base);
    expect(result.status).toBe("timeout");
    expect(result.reason).toBe("too slow");
    expect(base.settle).toHaveBeenCalledWith("brs_1", "unknown_usage");
  });

  it("maps every connector error onto a recorded step status", () => {
    expect(MCP_STATUS_MAP).toEqual({
      not_configured: "not_connected",
      network_error: "not_connected",
      unauthorized: "unauthorized",
      rate_limited: "rate_limited",
      timeout: "timeout",
      invalid_response: "invalid_response",
    });
  });
});
