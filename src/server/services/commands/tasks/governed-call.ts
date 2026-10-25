import { hasGrant, type Grant } from "@/lib/domain/policy";
import type { ToolStepStatus } from "@/lib/domain/tool-plan";
import type { ConnectorErrorCode } from "@/lib/connectors/types";
import type { McpOutcome } from "@/lib/mcp/client";

/**
 * The one place an external tool is actually called.
 *
 * Order is the contract: permission, then a durable hold, then the call, then a
 * settlement. Every exit path settles, because a hold that is never settled
 * keeps spending power reserved forever — the failure mode the budget ledger
 * exists to prevent.
 */
export type GovernedCallInput = {
  tool: string;
  /** The grant resource this tool needs, e.g. `mcp:github`. */
  resource: string;
  scope: "read" | "write";
  grants: Grant[];
  args: Record<string, unknown>;
  /** Cents held before the call. 0 while nothing bills per call, still held. */
  costCents?: number;
  admit: (
    amountCents: number,
  ) => Promise<{ allowed: false; reason: string } | { allowed: true; reservationId?: string }>;
  settle: (
    reservationId: string | undefined,
    settlement: "settled" | "released" | "unknown_usage",
  ) => Promise<void>;
  call: (args: Record<string, unknown>) => Promise<McpOutcome<string>>;
};

export type GovernedCallResult = {
  status: ToolStepStatus;
  reason: string;
  latencyMs: number;
  content: string | null;
};

/** Connector failures are recorded with the vocabulary a step already has. */
export const MCP_STATUS_MAP: Record<ConnectorErrorCode, ToolStepStatus> = {
  not_configured: "not_connected",
  network_error: "not_connected",
  unauthorized: "unauthorized",
  rate_limited: "rate_limited",
  timeout: "timeout",
  invalid_response: "invalid_response",
};

export async function governedCall(
  input: GovernedCallInput,
): Promise<GovernedCallResult> {
  // The grant check happens here as well as in `planTools`: this function is
  // the last thing before a network call, and a plan is not a permission.
  if (!hasGrant(input.grants, input.resource, input.scope)) {
    return {
      status: "unauthorized",
      reason: `No grant allows ${input.scope} on ${input.resource}.`,
      latencyMs: 0,
      content: null,
    };
  }

  const costCents = Math.max(0, input.costCents ?? 0);
  const admission = await input.admit(costCents);
  if (!admission.allowed) {
    return {
      status: "budget_exceeded",
      reason: admission.reason,
      latencyMs: 0,
      content: null,
    };
  }
  const reservationId = admission.reservationId;

  let outcome: McpOutcome<string>;
  try {
    outcome = await input.call(input.args);
  } catch (error) {
    await input.settle(reservationId, "released");
    return {
      status: "not_connected",
      reason: error instanceof Error ? error.message : "Tool call failed.",
      latencyMs: 0,
      content: null,
    };
  }

  if (outcome.ok) {
    await input.settle(reservationId, "settled");
    return {
      status: "ok",
      reason: `${input.tool} returned ${outcome.value.length} characters.`,
      latencyMs: outcome.latencyMs,
      content: outcome.value,
    };
  }

  // A timeout or a dropped connection may still have cost the provider
  // something; anything the server itself refused did not.
  const maybeCharged =
    outcome.error.code === "timeout" || outcome.error.code === "network_error";
  await input.settle(reservationId, maybeCharged ? "unknown_usage" : "released");
  return {
    status: MCP_STATUS_MAP[outcome.error.code],
    reason: outcome.error.message,
    latencyMs: outcome.latencyMs,
    content: null,
  };
}
