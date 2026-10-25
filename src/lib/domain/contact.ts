import type { ToolStepStatus } from "@/lib/domain/tool-plan";
import type { ConnectorErrorCode } from "@/lib/connectors/types";

/**
 * "Did a request actually leave this process?"
 *
 * Two different questions keep getting answered with one word, and both
 * mistakes are expensive (AGENTS.md 第 2 条):
 *
 * - A step claimed `provider` was contacted because a step existed at all.
 * - A crash was charged as `unknown_usage` because a label looked like proof.
 *
 * So the answer is recorded explicitly on the step (`attempted`), and the status
 * list below is only the fallback for rows written before that flag existed.
 */

/** Statuses a remote peer has to produce: they cannot come from a local refusal. */
export const CONTACT_STATUSES: readonly ToolStepStatus[] = [
  "ok",
  "timeout",
  "invalid_response",
  "rate_limited",
];

export function statusImpliesContact(status: string): boolean {
  return (CONTACT_STATUSES as readonly string[]).includes(status);
}

/**
 * True when an attempt may have cost money: the request was sent, and either a
 * response arrived or the socket died before one did. A refusal the server
 * itself sent back (401) or a budget veto proves nothing was spent.
 */
export function maybeContacted(code: ConnectorErrorCode): boolean {
  return code !== "unauthorized" && code !== "not_configured";
}

/**
 * True when a recorded step says a request left this process.
 *
 * An explicit `attempted` flag wins over the status, because the status alone
 * cannot tell "never called" from "called, then the socket hung up" — both are
 * `not_connected`. `provider` is deliberately ignored: it used to be written on
 * every MCP step, including the ones rejected before the network.
 */
export function stepMadeRequest(
  output: Record<string, unknown> | null | undefined,
): boolean {
  const out = output ?? {};
  if (typeof out.attempted === "boolean") return out.attempted;
  return statusImpliesContact(String(out.status ?? ""));
}
