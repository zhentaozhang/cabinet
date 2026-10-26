import { hasGrant, type Grant } from "./policy";

/**
 * Every tool names the resource and scope it needs. The tool a run may use is
 * therefore derived from data (`agents.tools` × `agent_grants`), never from the
 * agent's role — a role ternary silently gave Coach a research tool and made
 * grants decorative.
 */
export type ToolSpec = {
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
  /**
   * Specs discovered at runtime, e.g. one entry per tool on a configured MCP
   * server. They can widen the registry but not open it: a tool named by
   * neither `TOOL_SPECS` nor this map is still rejected as `unknown_tool`.
   */
  extraSpecs?: Record<string, ToolSpec>;
}): ToolPlan {
  const considered: ConsideredTool[] = [];
  const specs = resolveSpecs(input.extraSpecs);

  for (const tool of input.tools) {
    const decision = gateTool(tool, specs, input);
    if (!decision.allowed) {
      considered.push({ tool, accepted: false, reason: decision.rejection });
      continue;
    }
    considered.push({ tool, accepted: true });
    return {
      planned: {
        tool,
        resource: decision.spec.resource,
        scope: decision.spec.scope,
        kind: decision.spec.kind,
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

/**
 * 一个工具能不能用：注册表 → 动作类型 → 授权，三步的顺序在 planTools 里就是顺序。
 *
 * 抽出来的原因只有一个：`selectableTools` 要回答"模型能选哪些"，
 * 而"能不能选"必须和"会不会被放行"是同一个答案。两处各写一遍判断，
 * 迟早会出现"模型看不到却被授权"或"模型看得到却调用被拒"。
 */
function gateTool(
  tool: string,
  specs: Record<string, ToolSpec>,
  input: { grants: Grant[]; actionType: string },
):
  | { allowed: true; spec: ToolSpec }
  | { allowed: false; rejection: ToolRejection } {
  const spec = specs[tool];
  if (!spec) return { allowed: false, rejection: "unknown_tool" };
  // execute 类工具会改外部世界，内部动作里不允许出现，先于授权判断。
  if (spec.kind === "execute" && input.actionType === "internal") {
    return { allowed: false, rejection: "needs_action" };
  }
  // 授权问题只由 policy.hasGrant 回答：撤销、通配符、scope 等级都在它里面。
  if (!hasGrant(input.grants, spec.resource, spec.scope)) {
    return { allowed: false, rejection: "missing_grant" };
  }
  return { allowed: true, spec };
}

function resolveSpecs(
  extraSpecs?: Record<string, ToolSpec>,
): Record<string, ToolSpec> {
  return extraSpecs ? { ...TOOL_SPECS, ...extraSpecs } : TOOL_SPECS;
}

/** 交给模型挑的工具：名字 + 它需要的授权 + 是否必须人工审批。 */
export type SelectableTool = {
  tool: string;
  resource: string;
  scope: "read" | "write";
  kind: ToolSpec["kind"];
  /**
   * 写/执行类工具必须经人工审批，模型只能提出，不能自己拍板。
   * 这一位是"要不要审批"的唯一出处，UI 和执行链都读它。
   */
  requiresApproval: boolean;
};

/**
 * MCP 工具名以 `mcp:` 开头（见 tool-loop.ts）。
 *
 * 这里不 import 那个常量：domain 层不该反过来依赖 server 层，
 * 而 MCP 的 resource 来自数据库里的服务端行，本轮不交给模型挑。
 */
const MCP_PREFIX = "mcp:";

/**
 * 模型可以自己挑的工具清单。
 *
 * 与 planTools 的区别是"全给还是挑一个"：planTools 返回第一个可用的（确定性路径），
 * 这里返回全部可用的（交给模型选）。判定本身是同一次调用，所以两者永不分歧。
 */
export function selectableTools(input: {
  declaredTools: string[];
  grants: Grant[];
  actionType: string;
  extraSpecs?: Record<string, ToolSpec>;
}): SelectableTool[] {
  const specs = resolveSpecs(input.extraSpecs);
  const selected: SelectableTool[] = [];

  for (const tool of input.declaredTools) {
    // MCP 工具下一轮再开放：它的 resource 需要先查服务端行，这里给不出授权依据。
    if (tool.startsWith(MCP_PREFIX)) continue;
    const decision = gateTool(tool, specs, input);
    if (!decision.allowed) continue;
    selected.push({
      tool,
      resource: decision.spec.resource,
      scope: decision.spec.scope,
      kind: decision.spec.kind,
      // 只有读操作可以不经审批：写外部世界的事，模型只能提议。
      requiresApproval: decision.spec.kind !== "read",
    });
  }

  return selected;
}

/**
 * The step status a rejection is recorded under.
 *
 * One table for the whole system: the planner, the built-in tool step in
 * `run.ts` and the MCP loop all name the same rejection the same way. They used
 * to disagree — `unknown_tool` was `unauthorized` in one place and
 * `not_connected` in the other — so the same event read as two different facts.
 */
export const REJECTION_STATUS: Record<ToolRejection, ToolStepStatus> = {
  missing_grant: "unauthorized",
  needs_action: "unauthorized",
  unknown_tool: "not_connected",
};

/** Terminal states a tool step may report. `ok` is reserved for a real call. */
export type ToolStepStatus =
  | "ok"
  | "not_connected"
  /** Planned and permitted, but the task gave it nothing to act on. */
  | "skipped"
  | "unauthorized"
  | "rate_limited"
  | "timeout"
  | "invalid_response"
  /** The budget hold was refused, so the call was never made. */
  | "budget_exceeded"
  /** The run had already used its tool-step allowance. */
  | "step_limit";
