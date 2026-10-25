/**
 * The MCP tool loop against a real HTTP server and the real database.
 *
 * The point of the loop is not "a tool ran" — it is that the same gate as the
 * built-in tools (grant → hold → call → settle) still holds, and that a
 * workspace with no server behaves exactly as it did before MCP existed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { agentGrants, mcpServers, runs, steps } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { newId } from "@/lib/ids";
import { recoverStaleRuns } from "@/server/services/commands/tasks/recovery";
import { runTask } from "@/server/services/commands/tasks/run";
import type { ToolStepRecord } from "@/server/services/commands/tasks/tool-loop";
import { runMcpToolLoop } from "@/server/services/commands/tasks/tool-loop";
import { resetDb } from "../helpers/db";

let server: Server | null = null;
let base = "";
let calls: string[] = [];
let behaviour: "normal" | "slow" = "normal";

async function start(): Promise<void> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (behaviour === "slow" && body.method === "tools/call") return;
      if (body.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "sess_" + String(calls.length + 1),
        });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }),
        );
        return;
      }
      if (body.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (body.method === "tools/call") {
        calls.push(String(body.params?.name ?? ""));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: "found 3 things" }] },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server!.address();
  if (!address || typeof address === "string") throw new Error("no port");
  base = "http://127.0.0.1:" + String(address.port) + "/mcp";
}

async function stop(): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
}

async function addServer(name: string, resource: string): Promise<void> {
  await db.insert(mcpServers).values({
    id: newId("mcs"),
    userId: DEMO_USER_ID,
    name,
    url: base,
    resource,
    scope: "read",
    enabled: true,
  });
}

async function addGrant(resource: string, scope: "read" | "write" = "read"): Promise<void> {
  await db.insert(agentGrants).values({
    id: newId("grt"),
    agentId: "ag_coach",
    resource,
    scope,
    config: {},
  });
}

function collect(): { records: ToolStepRecord[]; step: (record: ToolStepRecord) => Promise<void> } {
  const records: ToolStepRecord[] = [];
  return {
    records,
    step: async (record: ToolStepRecord) => {
      records.push(record);
    },
  };
}

beforeEach(async () => {
  calls = [];
  behaviour = "normal";
  await resetDb();
  await start();
});

afterEach(async () => {
  await stop();
});

describe("runMcpToolLoop", () => {
  it("calls a declared MCP tool and records the result", async () => {
    await addServer("fake", "mcp:fake");
    await addGrant("mcp:fake");
    const sink = collect();

    const result = await runMcpToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_coach",
      taskId: "tsk_read",
      runId: "run_test_mcp",
      timezone: "UTC",
      tools: ["read_notes", "mcp:fake:search"],
      grants: [{ resource: "mcp:fake", scope: "read" }],
      actionType: "internal",
      input: "RAG 检索",
      step: sink.step,
    });

    expect(result).toEqual({ attempted: 1, ok: 1 });
    expect(calls).toEqual(["search"]);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0].output).toMatchObject({
      status: "ok",
      tool: "mcp:fake:search",
      provider: "mcp:fake",
      content: "found 3 things",
    });
  });

  it("refuses the call when no grant allows the server", async () => {
    await addServer("fake", "mcp:fake");
    const sink = collect();

    const result = await runMcpToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_coach",
      taskId: "tsk_read",
      runId: "run_test_mcp",
      timezone: "UTC",
      tools: ["mcp:fake:search"],
      grants: [{ resource: "notes", scope: "read" }],
      actionType: "internal",
      input: "RAG 检索",
      step: sink.step,
    });

    expect(result).toEqual({ attempted: 0, ok: 0 });
    expect(calls).toEqual([]);
    expect(sink.records[0].output.status).toBe("unauthorized");
  });

  it("does not let a server row lend an unrelated grant to a tool", async () => {
    // The grant is a statement about a *resource*, so a server row that claims
    // someone else's resource name would spend a permission nobody granted it.
    // The required resource is derived from the server name, not read from the
    // row, so relabelling a row cannot widen a grant.
    await addServer("shop", "web");
    await addGrant("web", "read");
    const sink = collect();

    const result = await runMcpToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_coach",
      taskId: "tsk_read",
      runId: "run_test_mcp",
      timezone: "UTC",
      tools: ["mcp:shop:search"],
      grants: [{ resource: "web", scope: "read" }],
      actionType: "internal",
      input: "RAG 检索",
      step: sink.step,
    });

    expect(result).toEqual({ attempted: 0, ok: 0 });
    expect(calls).toEqual([]);
    expect(sink.records[0].output).toMatchObject({
      status: "unauthorized",
      provider: "mcp:shop",
    });
  });

  it("records an unconfigured server instead of pretending", async () => {
    const sink = collect();

    await runMcpToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_coach",
      taskId: "tsk_read",
      runId: "run_test_mcp",
      timezone: "UTC",
      tools: ["mcp:ghost:ping"],
      grants: [{ resource: "mcp:ghost", scope: "read" }],
      actionType: "internal",
      input: "RAG 检索",
      step: sink.step,
    });

    expect(calls).toEqual([]);
    expect(sink.records[0].output.status).toBe("not_connected");
    expect(String(sink.records[0].output.reason)).toContain("ghost");
  });

  it("stops at the per-run tool-step ceiling", async () => {
    await addServer("fake", "mcp:fake");
    await addGrant("mcp:fake");
    const sink = collect();

    await runMcpToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_coach",
      taskId: "tsk_read",
      runId: "run_test_mcp",
      timezone: "UTC",
      tools: ["mcp:fake:a", "mcp:fake:b", "mcp:fake:c"],
      grants: [{ resource: "mcp:fake", scope: "read" }],
      actionType: "internal",
      input: "RAG 检索",
      step: sink.step,
      maxSteps: 2,
    });

    expect(calls).toEqual(["a", "b"]);
    expect(sink.records).toHaveLength(3);
    expect(sink.records[2].output).toMatchObject({
      status: "step_limit",
      limit: 2,
      skipped: ["mcp:fake:c"],
    });
  });

  it("records a timeout when the server never answers", async () => {
    await addServer("fake", "mcp:fake");
    await addGrant("mcp:fake");
    behaviour = "slow";
    const sink = collect();

    const result = await runMcpToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_coach",
      taskId: "tsk_read",
      runId: "run_test_mcp",
      timezone: "UTC",
      tools: ["mcp:fake:search"],
      grants: [{ resource: "mcp:fake", scope: "read" }],
      actionType: "internal",
      input: "RAG 检索",
      step: sink.step,
      timeoutMs: 150,
    });

    expect(result).toEqual({ attempted: 1, ok: 0 });
    expect(sink.records[0].output.status).toBe("timeout");
  });

  it("leaves a run with no MCP tool untouched", async () => {
    await runTask("tsk_read", DEMO_USER_ID);

    const rows = await db
      .select({ tool: steps.tool, type: steps.type, output: steps.output })
      .from(steps)
      .innerJoin(runs, eq(steps.runId, runs.id))
      .where(eq(runs.taskId, "tsk_read"));
    const toolSteps = rows.filter((row) => row.type === "tool");
    expect(toolSteps).toHaveLength(1);
    expect(toolSteps[0].tool).toBe("read_notes");
  });
});

describe("recovery with MCP steps", () => {
  it("treats a recorded MCP call as provider contact", async () => {
    const runId = newId("run");
    await db.insert(runs).values({
      id: runId,
      taskId: "tsk_read",
      agentId: "ag_coach",
      status: "running",
      mode: "demo",
      sourceType: "system_event",
      startedAt: new Date(Date.now() - 10 * 60_000),
      runLabel: "recovery_mcp",
    });
    await db.insert(steps).values({
      id: newId("stp"),
      runId,
      idx: 1,
      type: "tool",
      tool: "mcp:fake:search",
      input: {},
      output: { status: "ok", provider: "mcp:fake", content: "found 3 things" },
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 12,
    });

    await recoverStaleRuns({ olderThanMs: 0 });

    const [row] = await db
      .select({ status: runs.status, error: runs.error })
      .from(runs)
      .where(eq(runs.id, runId));
    expect(row.status).toBe("failed");
    expect(String(row.error)).toContain("可能已调用供应商");
  });
});
