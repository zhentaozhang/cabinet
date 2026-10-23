import { hasGrant, type Grant } from "./policy";

/**
 * Every tool names the resource and scope it needs. The tool a run may use is
 * therefore derived from data (`agents.tools` × `agent_grants`), never from the
 * agent's role — a role ternary silently gave Coach a research tool and made
 * grants decorative.
 */
type ToolSpec = {
  resource: string;
  scope: "read" | "write";
  /** `execute` tools change state outside Cabinet, so they need a real action. */
  kind: "read" | "write" | "execute";
};

const TOOL_SPECS: Record<string, ToolSpec> = {
  web_search: { resource: "web", scope: "read", kind: "read" },
  web_fetch: { resource: "web", scope: "read", kind: "read" },
  read_notes: { resource: "notes", scope: "read", kind: "read" },
  quiz: { resource: "notes", scope: "read", kind: "read" },
  write_task: { resource: "task", scope: "write", kind: "write" },
  dispatch: { resource: "task", scope: "write", kind: "write" },
  read_runs: { resource: "task", scope: "read", kind: "read" },
  calendar_read: { resource: "calendar", scope: "read", kind: "read" },
  ledger_read: { resource: "ledger", scope: "read", kind: "read" },
  budget_veto: { resource: "ledger", scope: "write", kind: "write" },
  read_artifacts: { resource: "artifacts", scope: "read", kind: "read" },
  audit_decision: { resource: "artifacts", scope: "write", kind: "write" },
  read_evidence: { resource: "artifacts", scope: "read", kind: "read" },
  read_all: { resource: "plan", scope: "read", kind: "read" },
  read_plan: { resource: "plan", scope: "read", kind: "read" },
  write_plan: { resource: "plan", scope: "write", kind: "write" },
  convene_council: { resource: "council", scope: "write", kind: "write" },
  sandbox_execute: { resource: "sandbox", scope: "write", kind: "execute" },
};

export type ToolRejection = "unknown_tool" | "missing_grant" | "needs_action";

export type ConsideredTool = {
  tool: string;
  accepted: boolean;
  reason?: ToolRejection;
};

export type ToolPlan = {
  planned: { tool: string; resource: string; scope: "read" | "write"; kind: ToolSpec["kind"] } | null;
  considered: ConsideredTool[];
  reason: string;
};

/**
 * Pick the first tool the agent is actually allowed to use.
 *
 * Order is the agent's own declaration order, so a well-ordered list reads as
 * a preference list. When nothing is permitted the plan is empty and the run
 * records `unauthorized` instead of pretending a tool exists.
 *
 * `grants` are the policy `Grant` rows as persisted, including `revokedAt`: the
 * permission question is answered by `policy.hasGrant` and nowhere else, so a
 * tool plan can never be more permissive than the run it belongs to.
 */
export function planTools(input: {
  tools: string[];
  grants: Grant[];
  actionType: string;
}): ToolPlan {
  const considered: ConsideredTool[] = [];

  for (const tool of input.tools) {
    const spec = TOOL_SPECS[tool];
    if (!spec) {
      considered.push({ tool, accepted: false, reason: "unknown_tool" });
      continue;
    }
    if (spec.kind === "execute" && input.actionType === "internal") {
      considered.push({ tool, accepted: false, reason: "needs_action" });
      continue;
    }
    if (!hasGrant(input.grants, spec.resource, spec.scope)) {
      considered.push({ tool, accepted: false, reason: "missing_grant" });
      continue;
    }
    considered.push({ tool, accepted: true });
    return {
      planned: {
        tool,
        resource: spec.resource,
        scope: spec.scope,
        kind: spec.kind,
      },
      considered,
      reason: "Tool permitted by grant.",
    };
  }

  return {
    planned: null,
    considered,
    reason:
      input.tools.length === 0
        ? "This Agent declares no tools."
        : "No declared tool is permitted for this Agent.",
  };
}

/** Terminal states a tool step may report. `ok` is reserved for a real call. */
export type ToolStepStatus =
  | "ok"
  | "not_connected"
  | "unauthorized"
  | "rate_limited"
  | "timeout"
  | "invalid_response";
