import { and, eq } from "drizzle-orm";
import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";

import { db } from "@/lib/db";
import { mcpServers } from "@/lib/db/schema";
import type { Grant } from "@/lib/domain/policy";
import {
  planTools,
  REJECTION_STATUS,
  type SelectableTool,
  type ToolSpec,
  type ToolStepStatus,
} from "@/lib/domain/tool-plan";
import { generateWithTools, type ModelToolStep } from "@/lib/llm";
import { createMcpClient } from "@/lib/mcp/client";
import { logEvent } from "@/lib/observability/log";
import { retrievalBudgetState, recordRetrievalCall } from "@/server/services/connectors/ledger";
import { fetchAndPersist } from "@/server/services/connectors/page";
import { searchAndPersist, type PersistedEvidence } from "@/server/services/connectors/search";

import { reserveBudget, settleBudget } from "./execution";
import { governedCall } from "./governed-call";

/**
 * Declared tools are namespaced: "mcp:<server>:<remote tool>". The middle
 * segment names a row in `mcp_servers`, so a grant can say "read on
 * mcp:github" without the tool list having to repeat every remote tool.
 */
export const MCP_TOOL_PREFIX = "mcp:";

/** Two calls per run by default: a loop with no ceiling is a budget leak. */
export const DEFAULT_MAX_TOOL_STEPS = 2;

/**
 * Per-call holds exist so the ledger sees every call. Nothing bills per call
 * yet, and a 0-cent hold still leaves the accounting trail a real price needs.
 */
export const MCP_TOOL_COST_CENTS = 0;

/** A step stores a preview, not a transcript; the full body stays upstream. */
const CONTENT_PREVIEW_CHARS = 2000;

export type ToolStepRecord = {
  type: string;
  tool?: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  latency?: number;
};

/** The run owns step numbering, so the loop writes through it. */
export type AddToolStep = (step: ToolStepRecord) => Promise<void>;

export function declaredMcpTools(tools: string[]): string[] {
  return tools.filter((tool) => tool.startsWith(MCP_TOOL_PREFIX));
}

export function maxToolSteps(): number {
  const raw = Number(process.env.RUN_MAX_TOOL_STEPS ?? DEFAULT_MAX_TOOL_STEPS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MAX_TOOL_STEPS;
  return Math.floor(raw);
}

export function parseToolName(tool: string): { server: string; remote: string } {
  const rest = tool.startsWith(MCP_TOOL_PREFIX)
    ? tool.slice(MCP_TOOL_PREFIX.length)
    : tool;
  const split = rest.indexOf(":");
  if (split === -1) return { server: rest, remote: "" };
  return { server: rest.slice(0, split), remote: rest.slice(split + 1) };
}

export type RunMcpToolLoopInput = {
  userId: string;
  agentId: string;
  taskId: string;
  runId: string;
  timezone: string;
  /** Everything the Agent declared: built-in tools plus MCP ones. */
  tools: string[];
  grants: Grant[];
  actionType: string;
  /** What the Agent is working on; sent upstream as the call argument. */
  input: string;
  step: AddToolStep;
  maxSteps?: number;
  /** Per-call network timeout; the client's default applies when omitted. */
  timeoutMs?: number;
};

/**
 * Call the MCP tools an Agent declared, under the same gate as built-in ones.
 *
 * Every declared tool gets exactly one terminal step, and a run that declares
 * no MCP tool writes nothing at all. That is what keeps an unconfigured
 * workspace byte-for-byte identical to the pre-MCP behaviour.
 */
export async function runMcpToolLoop(
  input: RunMcpToolLoopInput,
): Promise<{ attempted: number; ok: number }> {
  const declared = declaredMcpTools(input.tools);
  if (declared.length === 0) return { attempted: 0, ok: 0 };

  const servers = await db
    .select({
      name: mcpServers.name,
      url: mcpServers.url,
      scope: mcpServers.scope,
    })
    .from(mcpServers)
    .where(and(eq(mcpServers.userId, input.userId), eq(mcpServers.enabled, true)));
  const byName = new Map(servers.map((row) => [row.name, row]));

  const allowance = input.maxSteps ?? maxToolSteps();
  const queue = declared.slice(0, allowance);
  const skipped = declared.slice(allowance);
  let attempted = 0;
  let ok = 0;

  for (const tool of queue) {
    const { server: serverName, remote } = parseToolName(tool);
    const server = byName.get(serverName);
    if (!server) {
      await input.step({
        type: "tool",
        tool,
        input: {},
        output: {
          status: "not_connected",
          tool,
          provider: null,
          attempted: false,
          reason:
            'No MCP server named "' + serverName + '" is configured.',
        },
      });
      continue;
    }

    const remoteTool = remote.length > 0 ? remote : tool;
    // The required resource comes from the server *name*, never from a column:
    // a row that claimed "web" would otherwise spend a grant nobody issued to
    // it. Grants say "read on mcp:github", and this is the same string.
    const spec: ToolSpec = {
      resource: MCP_TOOL_PREFIX + server.name,
      scope: server.scope === "write" ? "write" : "read",
      kind: server.scope === "write" ? "write" : "read",
    };
    const plan = planTools({
      tools: [tool],
      grants: input.grants,
      actionType: input.actionType,
      extraSpecs: { [tool]: spec },
    });

    const provider = "mcp:" + server.name;
    if (!plan.planned) {
      const rejection = plan.considered[0]?.reason ?? "unknown_tool";
      await input.step({
        type: "tool",
        tool,
        input: {},
        // No request is sent on this path, so it must not claim a provider and
        // must not look "possibly charged" to the recovery pass (5f332e7f 阻断 3).
        output: {
          status: REJECTION_STATUS[rejection],
          tool,
          server: server.name,
          attempted: false,
          reason: plan.reason,
        },
      });
      continue;
    }

    const client = createMcpClient({
      url: server.url,
      clientName: "cabinet",
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    const args: Record<string, unknown> = { query: input.input };

    const result = await governedCall({
      tool,
      resource: plan.planned.resource,
      scope: plan.planned.scope,
      grants: input.grants,
      args,
      costCents: MCP_TOOL_COST_CENTS,
      admit: async (amountCents) => {
        const reserved = await reserveBudget({
          userId: input.userId,
          agentId: input.agentId,
          taskId: input.taskId,
          timezone: input.timezone,
          amountCents,
        });
        return reserved.allowed
          ? { allowed: true as const, reservationId: reserved.reservationId }
          : { allowed: false as const, reason: reserved.reason };
      },
      settle: async (reservationId, settlement) => {
        if (!reservationId) return;
        await db.transaction(async (tx) => {
          await settleBudget(tx, {
            reservationId,
            settlement:
              settlement === "settled"
                ? { state: "known_usage", estimatedCents: MCP_TOOL_COST_CENTS }
                : settlement === "unknown_usage"
                  ? { state: "unknown_usage" }
                  : { state: "not_contacted" },
            reason: "MCP tool call (" + settlement + ") via " + provider,
          });
        });
      },
      call: (callArgs) => client.callTool(remoteTool, callArgs),
    });

    // Counted from the result, not before the call: a budget or grant refusal
    // never reached the network and must not inflate "attempted" in the log.
    if (result.attempted) attempted += 1;
    if (result.status === "ok") ok += 1;
    const content = result.content;
    await input.step({
      type: "tool",
      tool,
      input: { arguments: args },
      output: {
        status: result.status,
        tool,
        // Only a step that really called out names a provider; run.ts's built-in
        // path has always followed that rule.
        provider: result.attempted ? provider : null,
        attempted: result.attempted,
        remoteTool,
        reason: result.reason,
        content:
          content === null ? null : content.slice(0, CONTENT_PREVIEW_CHARS),
        ...(content !== null && content.length > CONTENT_PREVIEW_CHARS
          ? { truncated: true, contentChars: content.length }
          : {}),
      },
      latency: result.latencyMs,
    });
  }

  if (skipped.length > 0) {
    // One row explains every tool the allowance refused, so the run shows the
    // ceiling instead of silently dropping names.
    await input.step({
      type: "tool",
      input: {},
      output: {
        status: "step_limit",
        provider: null,
        limit: allowance,
        skipped,
        reason:
          "This run allows " +
          allowance +
          " MCP tool call(s); " +
          skipped.length +
          " declared tool(s) were not attempted.",
      },
    });
  }

  logEvent("info", "mcp.loop.finished", {
    runId: input.runId,
    declared: declared.length,
    attempted,
    ok,
    skipped: skipped.length,
  });
  return { attempted, ok };
}

/** 默认三次：一次检索 + 一次抓取 + 一次补救，再多就是模型在试错。 */
export const DEFAULT_MODEL_TOOL_STEPS = 3;

/**
 * 模型可以自己挑的工具有且只有这两个：它们背后是真的连接器。
 * 名单之外的东西即使被授权，也没有执行器，模型选了也只能记 not_connected。
 */
export const MODEL_TOOL_NAMES = ["web_search", "web_fetch"] as const;
export type ModelToolName = (typeof MODEL_TOOL_NAMES)[number];

/** 按次计费的只有检索；抓一个指名页面不计费（与 run.ts 的 billable 一致）。 */
const MODEL_TOOL_BILLABLE: Record<ModelToolName, boolean> = {
  web_search: true,
  web_fetch: false,
};

/**
 * 一次计费检索的预估成本（3 分），用于原子预留。
 *
 * 真实单价由连接器按请求报账（ledger 里的口径），这里只需要一个"不比实际小太多"
 * 的单次上限：留 0 分等于没有预留，并发时谁都能挤进来；留得过大又会把没花的额度锁死。
 * 单次网页检索的实际价格就在几分钱这个量级，所以取 3。
 */
export const MODEL_TOOL_COST_CENTS = 3;

const MODEL_TOOL_HINTS: Record<ModelToolName, string> = {
  web_search: "检索外部来源，只返回可引用的片段；需要给出具体的检索词。",
  web_fetch: "抓取一个已经确定的 http/https 页面正文；需要给出完整链接。",
};

const MODEL_TOOL_SCHEMAS: Record<ModelToolName, JSONSchema7> = {
  web_search: {
    type: "object",
    properties: {
      query: { type: "string", description: "检索词，来自任务本身，不要编造主题。" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  web_fetch: {
    type: "object",
    properties: {
      url: { type: "string", description: "要抓取的完整 http/https 链接。" },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

export function isModelToolName(tool: string): tool is ModelToolName {
  return (MODEL_TOOL_NAMES as readonly string[]).includes(tool);
}

/** 任务里模型需要的全部上下文；actionType 决定 execute 类工具能不能出现。 */
export type ModelToolTask = {
  title: string;
  description: string;
  acceptanceCriteria?: string;
  actionType: string;
};

/**
 * 一次真实检索的结果。执行器只负责"调用连接器并如实报告"，
 * 授权、预算、记账、step 全部由循环做——执行器没有权限自己记账。
 */
export type RetrievalOutcome = {
  status: ToolStepStatus;
  provider: string | null;
  /** 命中的条数（不是正文）；正文已经落库成证据，不需要回传。 */
  hits: number;
  latencyMs: number;
  evidence: PersistedEvidence[];
  message: string | null;
};

export type ModelToolExecutor = (call: {
  userId: string;
  agentId: string;
  taskId: string;
  runId: string;
  input: { query?: string; url?: string };
}) => Promise<RetrievalOutcome>;

/** 交给"模型"（或测试里的假模型）的工具表：名字 + 描述 + 可执行体。 */
export type ModelToolRegistry = Record<
  string,
  { description: string; execute: (input: unknown) => Promise<unknown> }
>;

/** 一次模型调用的 token 用量；null 表示这次调用没有产生可记账的用量。 */
export type ModelToolUsage = { inputTokens: number; outputTokens: number };

export type ModelToolGeneration = {
  status: string;
  text: string;
  /** 模型声称自己调了什么；循环会拿它比对"是不是真的执行过"。 */
  steps: ModelToolStep[];
  /**
   * 这次模型调用本身的用量与模型名。
   *
   * 调用方按 token 计费，如果生成器把这两个字段丢掉，上层就只能看到
   * generateArtifact 那一次的费用，却仍然写着 costSource: "actual"。
   */
  usage?: ModelToolUsage | null;
  model?: string | null;
};

/**
 * 生成器的注入点。
 *
 * 生产实现走 AI SDK（llm.generateWithTools + stopWhen），测试注入假模型，
 * 于是"模型会选什么"变成一个普通函数，测试既不需要网络也不需要密钥。
 */
export type ModelToolGenerator = (input: {
  system: string;
  prompt: string;
  tools: ModelToolRegistry;
  maxSteps: number;
}) => Promise<ModelToolGeneration>;

export type RunModelToolLoopInput = {
  userId: string;
  agentId: string;
  taskId: string;
  runId: string;
  /** 预算周期按用户时区切分，预留必须用与 run 级预留同一个时区。 */
  timezone: string;
  task: ModelToolTask;
  /** 规划时的可选工具（selectableTools 的结果）；执行前仍会再查一次授权。 */
  allowed: SelectableTool[];
  grants: Grant[];
  /** 覆盖默认连接器执行器，仅供测试注入。 */
  executors?: Partial<Record<ModelToolName, ModelToolExecutor>>;
  /** 默认 llm.generateWithTools。 */
  generate?: ModelToolGenerator;
  maxSteps?: number;
  step: AddToolStep;
};

function skippedOutcome(message: string): RetrievalOutcome {
  return {
    status: "skipped",
    provider: null,
    hits: 0,
    latencyMs: 0,
    evidence: [],
    message,
  };
}

/** 生产执行器：就是 run.ts 老路径调的那两个连接器，一行业务都没重写。 */
function connectorExecutors(): Record<ModelToolName, ModelToolExecutor> {
  return {
    web_search: async (call) => {
      const query = call.input.query ?? "";
      if (!query) return skippedOutcome("模型没有给出检索词，本次未发起检索。");
      const result = await searchAndPersist({
        userId: call.userId,
        taskId: call.taskId,
        runId: call.runId,
        query,
      });
      return {
        status: result.status,
        provider: result.provider,
        hits: result.hits.length,
        latencyMs: result.latencyMs,
        evidence: result.evidence,
        message: result.message,
      };
    },
    web_fetch: async (call) => {
      const url = call.input.url ?? "";
      if (!url) return skippedOutcome("模型没有给出 URL，本次未发起抓取。");
      // 协议、私网、跳转的安全判断都在 fetchPage 里，这里不重复实现一遍。
      const result = await fetchAndPersist({
        userId: call.userId,
        taskId: call.taskId,
        runId: call.runId,
        url,
      });
      return {
        status: result.status,
        provider: result.provider,
        hits: result.hits.length,
        latencyMs: result.latencyMs,
        evidence: result.evidence,
        message: result.message,
      };
    },
  };
}

/** 生产生成器：把工具表翻成 SDK 的 ToolSet，其余交给 llm.generateWithTools。 */
function defaultGenerator(): ModelToolGenerator {
  return async ({ system, prompt, tools: registry, maxSteps }) => {
    const toolSet: ToolSet = Object.fromEntries(
      Object.entries(registry).map(([name, definition]) => [
        name,
        tool({
          description: definition.description,
          inputSchema: jsonSchema(
            isModelToolName(name)
              ? MODEL_TOOL_SCHEMAS[name]
              : { type: "object", properties: {} },
          ),
          execute: async (args: unknown) => definition.execute(args),
        }),
      ]),
    );
    const result = await generateWithTools({
      system,
      prompt,
      tools: toolSet,
      maxSteps,
    });
    return {
      status: result.status,
      text: result.text,
      steps: result.steps,
      usage: result.usage,
      model: result.model,
    };
  };
}

function modelToolSystemPrompt(tools: ModelToolName[], maxSteps: number): string {
  return [
    "你在为一次任务执行挑选工具。",
    `本次最多允许调用 ${maxSteps} 次工具，超出的部分会被直接拒绝。`,
    "只能从下面列出的工具里选；没有合适的就一个都不要调，并说明缺少什么。",
    ...tools.map((name) => `- ${name}：${MODEL_TOOL_HINTS[name]}`),
    "检索词要具体，不要编造 URL 或引用。",
  ].join("\n");
}

function modelToolUserPrompt(task: ModelToolTask): string {
  return [
    `任务：${task.title}`,
    `描述：${task.description}`,
    `验收标准：${task.acceptanceCriteria ?? "无"}`,
    "现在决定是否需要工具，需要就用工具取证据。",
  ].join("\n");
}

/** 模型给的参数一律当不可信输入：只取认识的字段，顺手去掉空白。 */
function normaliseArgs(
  name: ModelToolName,
  raw: unknown,
): { query?: string; url?: string } {
  const record = (raw ?? {}) as Record<string, unknown>;
  if (name === "web_search") {
    return typeof record.query === "string" ? { query: record.query.trim() } : {};
  }
  return typeof record.url === "string" ? { url: record.url.trim() } : {};
}

/**
 * 让模型自己决定用哪个工具，但每一次调用仍然走既有的治理。
 *
 * 三道闸门按顺序：步数上限 → 授权 → 检索预算。顺序不是随意的——
 * 越界和越权的调用根本不该产生一次计费请求，所以它们都在执行器之前。
 *
 * 复用而不是复制：授权判定是 planTools（同一个 gateTool），
 * 预算与记账是 connectors/ledger 的 retrievalBudgetState / recordRetrievalCall，
 * 真正的外部调用是 connectors 的 searchAndPersist / fetchAndPersist。
 */
export type ModelToolLoopResult = {
  attempted: number;
  ok: number;
  evidence: PersistedEvidence[];
  /** 模型那次真实计费调用的用量；没有成功的调用就是 null。 */
  usage: ModelToolUsage | null;
  /** 同上：没有成功的调用就没有"是谁调的"。 */
  model: string | null;
};

export async function runModelToolLoop(
  input: RunModelToolLoopInput,
): Promise<ModelToolLoopResult> {
  const maxSteps = Math.max(0, Math.floor(input.maxSteps ?? DEFAULT_MODEL_TOOL_STEPS));
  // 只留真有执行器的连接器：模型能选的必须是这里跑得动的东西。
  const allowed = input.allowed.filter((item) => isModelToolName(item.tool));
  if (allowed.length === 0 || maxSteps === 0) {
    // 没有可选工具就不该花一次模型调用，也不该写空气 step。
    return { attempted: 0, ok: 0, evidence: [], usage: null, model: null };
  }

  const names = allowed.map((item) => item.tool as ModelToolName);
  const executors = { ...connectorExecutors(), ...input.executors };
  const evidence: PersistedEvidence[] = [];
  /** 被上限拒掉的调用，最后合成一条 step_limit 说明。 */
  const refused: string[] = [];
  let attempted = 0;
  let ok = 0;
  let used = 0;

  /**
   * 预算拒单的唯一出口。
   *
   * step 记成 budget_exceeded（ToolStepStatus 早有这个状态，页面也有对应文案），
   * 台账依旧记 skipped/billable:false——那是"有没有产生费用"的账，
   * 与"为什么没发起"是两件事，混在一起会让对账时看不出一分钱都没花。
   */
  const refuseCall = async (
    name: ModelToolName,
    args: { query?: string; url?: string },
    reason: string,
  ) => {
    await recordRetrievalCall({
      userId: input.userId,
      taskId: input.taskId,
      runId: input.runId,
      tool: name,
      provider: null,
      status: "skipped",
      hits: 0,
      latencyMs: 0,
      billable: false,
    });
    await input.step({
      type: "tool",
      tool: name,
      input: { arguments: args },
      output: {
        status: "budget_exceeded",
        tool: name,
        provider: null,
        attempted: false,
        selectedBy: "model",
        budgetExceeded: true,
        reason,
      },
    });
  };

  const runOne = async (name: ModelToolName, raw: unknown): Promise<unknown> => {
    const args = normaliseArgs(name, raw);

    // 闸门一：步数上限。超出即停，不产生任何外部请求。
    if (used >= maxSteps) {
      refused.push(name);
      return { status: "step_limit", attempted: false };
    }

    // 闸门二：授权。allowed 是规划时的快照，这里按当前 grants 再问一次，
    // 于是"规划后被撤销的授权"会在真正调用之前生效。
    const plan = planTools({
      tools: [name],
      grants: input.grants,
      actionType: input.task.actionType,
    });
    if (!plan.planned) {
      const rejection = plan.considered[0]?.reason ?? "unknown_tool";
      const status = REJECTION_STATUS[rejection];
      await input.step({
        type: "tool",
        tool: name,
        input: { arguments: args },
        // 没有请求发出，所以没有 provider、也不叫 attempted。
        output: {
          status,
          tool: name,
          provider: null,
          attempted: false,
          selectedBy: "model",
          reason: plan.reason,
        },
      });
      return { status, attempted: false };
    }

    // 闸门三：本周检索预算。只拦按次计费的工具，免费抓取不受牵连。
    //
    // 两层都要过，而且顺序不能反：先看周上限（快速、跨所有 run 的硬顶），
    // 再做原子预留（把这一份额度先锁住）。只读一次余额就放行是不够的——
    // 两个并发 run 会读到同一份余额，然后把同一份额度各花一遍。
    const billable = MODEL_TOOL_BILLABLE[name];
    let reservationId: string | null = null;
    if (billable) {
      const budget = await retrievalBudgetState(input.userId);
      if (budget.exhausted) {
        await refuseCall(
          name,
          args,
          `本周检索预算已用尽（上限 ${(budget.limitCents / 100).toFixed(2)} 元），本次未发起外部检索。`,
        );
        return { status: "budget_exceeded", attempted: false };
      }
      const reserved = await reserveBudget({
        userId: input.userId,
        agentId: input.agentId,
        taskId: input.taskId,
        timezone: input.timezone,
        amountCents: MODEL_TOOL_COST_CENTS,
      });
      if (!reserved.allowed) {
        // 周上限还没到，但扣掉别的 run 正在占用的部分后已经不够这一次：
        // 拒绝必须发生在请求之前，否则就成了"先花钱、后找额度"。
        await refuseCall(
          name,
          args,
          `预算不足，本次未发起外部检索：${reserved.reason}`,
        );
        return { status: "budget_exceeded", attempted: false };
      }
      reservationId = reserved.reservationId;
    }

    // 真实调用。到这里才允许产生费用。
    used += 1;
    attempted += 1;
    let outcome: RetrievalOutcome;
    let threw = false;
    try {
      outcome = await executors[name]!({
        userId: input.userId,
        agentId: input.agentId,
        taskId: input.taskId,
        runId: input.runId,
        input: args,
      });
    } catch (error) {
      threw = true;
      // 执行器抛错时请求可能已经发出去了，所以按"调了但没结果"记账。
      outcome = {
        status: "invalid_response",
        provider: null,
        hits: 0,
        latencyMs: 0,
        evidence: [],
        message: `执行器失败：${error instanceof Error ? error.name : "unknown"}，结果未知。`,
      };
    }
    if (outcome.status === "ok") ok += 1;
    evidence.push(...outcome.evidence);

    if (reservationId) {
      // 占着预留不结算，别的 run 会一直看到"额度不够"，所以调用一结束就结清。
      // 抛错时并不知道请求有没有发出去，只能记 unknown_usage（可能已经花了钱）。
      await db.transaction(async (tx) => {
        await settleBudget(tx, {
          reservationId,
          settlement:
            outcome.status === "not_connected" ||
            outcome.status === "unauthorized" ||
            outcome.status === "skipped"
              ? { state: "not_contacted" }
              : outcome.status === "ok"
                ? { state: "known_usage", estimatedCents: MODEL_TOOL_COST_CENTS }
                : { state: "unknown_usage" },
          reason: `model tool call (${threw ? "executor_error" : outcome.status}) via ${outcome.provider ?? "none"}`,
        });
      });
    }

    await recordRetrievalCall({
      userId: input.userId,
      taskId: input.taskId,
      runId: input.runId,
      tool: name,
      provider: outcome.provider,
      status: outcome.status,
      hits: outcome.hits,
      latencyMs: outcome.latencyMs,
      billable,
    });

    await input.step({
      type: "tool",
      tool: name,
      input: { arguments: args },
      output: {
        status: outcome.status,
        tool: name,
        provider: outcome.provider,
        attempted: true,
        selectedBy: "model",
        reason:
          outcome.message ??
          `${name} 返回 ${outcome.hits} 条可引用来源，已落库。`,
        hits: outcome.hits,
        evidence: outcome.evidence.map((item) => ({
          id: item.id,
          url: item.url,
          title: item.title,
          publisher: item.publisher,
        })),
        latencyMs: outcome.latencyMs,
      },
      latency: outcome.latencyMs,
    });

    return {
      status: outcome.status,
      attempted: true,
      provider: outcome.provider,
      hits: outcome.hits,
    };
  };

  const registry: ModelToolRegistry = {};
  for (const name of names) {
    registry[name] = {
      description: MODEL_TOOL_HINTS[name],
      execute: (raw: unknown) => runOne(name, raw),
    };
  }

  const generation = await (input.generate ?? defaultGenerator())({
    system: modelToolSystemPrompt(names, maxSteps),
    prompt: modelToolUserPrompt(input.task),
    tools: registry,
    maxSteps,
  });

  if (generation.status !== "success") {
    // 模型没配置或失败：如实记录"没有发生任何工具调用"，不伪造一条成功。
    await input.step({
      type: "tool",
      input: {},
      output: {
        status: "not_connected",
        provider: null,
        attempted: false,
        selectedBy: "model",
        reason:
          generation.status === "not_configured"
            ? "模型未配置（OPENAI_API_KEY），本次没有发起任何工具调用。"
            : `模型调用失败（${generation.status}），本次没有发起任何工具调用。`,
      },
    });
  }

  // 模型点名了本次没提供给它的工具：SDK 不会执行它，这里必须留下记录，
  // 否则日志里会出现"模型以为调过、系统里查无此事"的空洞。
  for (const recorded of generation.steps) {
    if (registry[recorded.toolName]) continue;
    await input.step({
      type: "tool",
      tool: recorded.toolName,
      input: { arguments: recorded.input },
      output: {
        status: "not_connected",
        tool: recorded.toolName,
        provider: null,
        attempted: false,
        selectedBy: "model",
        reason: "模型请求了一个本次没有提供给它的工具，因此没有调用任何连接器。",
      },
    });
  }

  if (refused.length > 0) {
    await input.step({
      type: "tool",
      input: {},
      output: {
        status: "step_limit",
        provider: null,
        limit: maxSteps,
        skipped: refused,
        reason: `本次运行最多允许 ${maxSteps} 次工具调用，${refused.length} 次被拒。`,
      },
    });
  }

  logEvent("info", "model.tools.finished", {
    runId: input.runId,
    allowed: names.length,
    attempted,
    ok,
    refused: refused.length,
    evidence: evidence.length,
  });

  // 模型调用失败（超时、provider 报错）没有可信用量：宁可 null，也不要编一个 0 出来
  // 让上层以为这次费用已结清。
  const calledModel = generation.status === "success";

  return {
    attempted,
    ok,
    evidence,
    usage: calledModel ? (generation.usage ?? null) : null,
    model: calledModel ? (generation.model ?? null) : null,
  };
}
