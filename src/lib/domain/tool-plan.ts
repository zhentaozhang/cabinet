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
  /**
   * 这个工具在本运行时有没有真的执行器。授权（能不能用）和执行（跑了没有）
   * 是两个问题，注册表以前只回答第一个，于是界面把 18 个工具都画成可用，
   * 而 `run.ts` 只有 `web_search`/`web_fetch` 两个分支。
   *
   * 用 boolean 而不是 executor 字符串：字符串会诱使填一个并不存在的执行器名
   * （"connector:ledger" 之类），读起来像证据，其实只是另一个声明。真正执行
   * 的那段代码在 `run.ts` 的分发链里，这里只记录它存在与否。
   *
   * 可选只为容纳运行期发现的 spec（MCP）：它们的执行器是 `tool-loop.ts`，
   * 静态表没有资格替它们回答。静态注册表本身用下面的 `StaticToolSpec` 强制必填
   * ——漏标必须是编译错误，不能默认成"未接入"，否则这一位会静悄悄地变成 false。
   */
  implemented?: boolean;
};

/**
 * 静态注册表用的 spec：`implemented` 必填。
 *
 * 少写一个 bool 不是小事：它等于把"能不能执行"这个问题留给读者猜，
 * 而能力矩阵正是靠这一位决定渲染成实线还是虚线。
 */
type StaticToolSpec = ToolSpec & { implemented: boolean };

const TOOL_SPECS: Record<string, StaticToolSpec> = {
  // 只有这两个在 run.ts 里有真实执行链（检索/抓取并落证据），其余 16 个到此为止。
  web_search: { resource: "web", scope: "read", kind: "read", implemented: true },
  web_fetch: { resource: "web", scope: "read", kind: "read", implemented: true },
  read_notes: { resource: "notes", scope: "read", kind: "read", implemented: false },
  quiz: { resource: "notes", scope: "read", kind: "read", implemented: false },
  write_task: { resource: "task", scope: "write", kind: "write", implemented: false },
  dispatch: { resource: "task", scope: "write", kind: "write", implemented: false },
  read_runs: { resource: "task", scope: "read", kind: "read", implemented: false },
  calendar_read: { resource: "calendar", scope: "read", kind: "read", implemented: false },
  ledger_read: { resource: "ledger", scope: "read", kind: "read", implemented: false },
  budget_veto: { resource: "ledger", scope: "write", kind: "write", implemented: false },
  read_artifacts: { resource: "artifacts", scope: "read", kind: "read", implemented: false },
  audit_decision: { resource: "artifacts", scope: "write", kind: "write", implemented: false },
  read_evidence: { resource: "artifacts", scope: "read", kind: "read", implemented: false },
  read_all: { resource: "plan", scope: "read", kind: "read", implemented: false },
  read_plan: { resource: "plan", scope: "read", kind: "read", implemented: false },
  write_plan: { resource: "plan", scope: "write", kind: "write", implemented: false },
  convene_council: { resource: "council", scope: "write", kind: "write", implemented: false },
  sandbox_execute: { resource: "sandbox", scope: "write", kind: "execute", implemented: false },
};

/**
 * 注册表本身。界面和测试都读这一份：能力矩阵若自己维护一份"已接入"清单，
 * 就会与 `run.ts` 的分发链悄悄分叉，于是页面写"已接入"、运行写
 * not_connected——两个都说自己对。
 */
export function toolPlanRegistry(): Readonly<Record<string, ToolSpec>> {
  return TOOL_SPECS;
}

/**
 * 这个工具名在本运行时有没有真的执行器。
 *
 * 三个刻意的答案：
 * - 注册表里标了 implemented 的 → true；
 * - 注册表里声明但没接线的 → false（"声明了"不等于"能执行"，这正是要暴露的事）；
 * - 注册表不认识的名字（含 `mcp:` 开头、运行期才发现的工具）→ false：静态注册表
 *   没有资格替它们回答"能执行"，那是 `tool-loop.ts` 拿到服务端行之后的事。
 */
export function isImplemented(tool: string): boolean {
  return TOOL_SPECS[tool]?.implemented === true;
}

/**
 * 能力矩阵的两个分组，顺序 = 注册表的声明顺序，界面照抄即可。
 * `declaredOnly` 这个名字是给读者看的：不是"还没做完"，是"根本执行不了"。
 */
export function capabilitySummary(): {
  implemented: string[];
  declaredOnly: string[];
} {
  const implemented: string[] = [];
  const declaredOnly: string[] = [];
  for (const [tool, spec] of Object.entries(TOOL_SPECS)) {
    (spec.implemented ? implemented : declaredOnly).push(tool);
  }
  return { implemented, declaredOnly };
}

/**
 * 写进 tool step 的 reason：为什么这个工具什么都没做。
 *
 * 两种失败必须读起来不一样。注册表说能跑、执行链却没有分发到它，那是代码 bug，
 * 用"缺一个 connector"来描述它，bug 就会永久藏在"环境没配"里；反过来，把一个从未
 * 接线的本地工具（read_notes）说成"没配外部连接器"，是在让用户去修一个并不存在的
 * 设置。两句文案都明确写出"未发送"：用户最先担心的是有没有东西被偷偷发出去。
 */
export function notConnectedReason(tool: string): string {
  if (isImplemented(tool)) {
    return `工具 ${tool} 在注册表里标为已接入，但本运行时的执行链没有分发到它：注册表与执行链不一致，这一条要修代码，不是改配置。本次未执行、未发送任何请求。`;
  }
  return `工具 ${tool} 已声明但未接入（declared only，注册表 implemented: false）：本运行时没有它的执行器，所以它一步也执行不了。本次未执行、未发送任何请求，任务内容没有因此丢失。`;
}

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
