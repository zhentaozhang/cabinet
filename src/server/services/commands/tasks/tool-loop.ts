import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { mcpServers } from "@/lib/db/schema";
import type { Grant } from "@/lib/domain/policy";
import {
  planTools,
  REJECTION_STATUS,
  type ToolSpec,
} from "@/lib/domain/tool-plan";
import { createMcpClient } from "@/lib/mcp/client";
import { logEvent } from "@/lib/observability/log";

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
    attempted += 1;

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
