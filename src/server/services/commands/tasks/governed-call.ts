import { maybeContacted } from "@/lib/domain/contact";
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
  /**
   * Whether `call` was invoked at all. A refused call reports false even though
   * its status (`unauthorized`, `budget_exceeded`) is written into the run, and
   * the recovery pass reads exactly this flag instead of guessing from labels.
   */
  attempted: boolean;
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
      attempted: false,
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
      attempted: false,
    };
  }
  const reservationId = admission.reservationId;

  let outcome: McpOutcome<string>;
  try {
    outcome = await input.call(input.args);
  } catch (error) {
    // The throw may have happened before or after the request left the socket,
    // and this layer cannot tell. "No cost" would be a guess about someone
    // else's ledger, so the hold is closed as unknown usage.
    await input.settle(reservationId, "unknown_usage");
    return {
      status: "not_connected",
      reason: error instanceof Error ? error.message : "Tool call failed.",
      latencyMs: 0,
      content: null,
      attempted: true,
    };
  }

  if (outcome.ok) {
    await input.settle(reservationId, "settled");
    return {
      status: "ok",
      reason: `${input.tool} returned ${outcome.value.length} characters.`,
      latencyMs: outcome.latencyMs,
      content: outcome.value,
      attempted: true,
    };
  }

  // A timeout, a dropped connection, an unparseable reply or a 429 all mean the
  // request reached someone; only the server's own refusal (401/403) is taken
  // as evidence that nothing was spent, so that hold is released while the
  // others are charged as unknown usage.
  //
  // The step still records `attempted: true` for a 401: the refusal did cross
  // the wire. If the process dies before the settlement above, this call never
  // wrote a step, so nothing claims contact and the hold is refunded rather
  // than charged — the coarse, in-the-refund direction. Two different sweeps
  // do that, and the per-call hold is the slower one: it carries no run id, so
  // `recoverStaleRuns` cannot see it; the maintenance tick's
  // `releaseStaleHolds` releases it after 15 minutes (maintenance.ts), while
  // the run-level hold is settled by the recovery pass itself.
  await input.settle(
    reservationId,
    maybeContacted(outcome.error.code) ? "unknown_usage" : "released",
  );
  return {
    status: MCP_STATUS_MAP[outcome.error.code],
    reason: outcome.error.message,
    latencyMs: outcome.latencyMs,
    content: null,
    attempted: true,
  };
}
