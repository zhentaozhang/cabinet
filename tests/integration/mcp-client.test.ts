/**
 * The MCP client against a real HTTP server, in-process.
 *
 * A stub `fetch` would pass while the headers, the session handshake and the
 * SSE branch were all wrong — those are exactly the parts a third-party server
 * is strict about, so the test speaks HTTP to a server it starts itself.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpClient } from "@/lib/mcp/client";
import { MCP_PROTOCOL_VERSION } from "@/lib/mcp/protocol";

type Recorded = { method: string; session: string | null; version: string | null; accept: string | null };

let server: Server | null = null;
let seen: Recorded[] = [];
let behaviour: "normal" | "expired" | "unauthorized" | "slow" | "broken" = "normal";
let seq = 0;
const revoked = new Set<string>();

async function start(): Promise<string> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      seen.push({
        method: body.method ?? "",
        session: (req.headers["mcp-session-id"] as string) ?? null,
        version: (req.headers["mcp-protocol-version"] as string) ?? null,
        accept: (req.headers.accept as string) ?? null,
      });

      if (behaviour === "unauthorized") {
        res.writeHead(401).end("no");
        return;
      }
      if (behaviour === "slow") {
        // Never answer: the client's own timeout has to end this.
        return;
      }
      if (behaviour === "broken") {
        res.writeHead(500).end("boom");
        return;
      }
      if (behaviour === "expired" && req.headers["mcp-session-id"]) {
        // Only the session that was issued before the "restart" is invalid;
        // a freshly initialised one has to work, or nothing could recover.
        const current = req.headers["mcp-session-id"] as string;
        if (revoked.has(current)) {
          res.writeHead(404).end("gone");
          return;
        }
      }

      if (body.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": `sess_${(seq += 1)}`,
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "fake" } },
          }),
        );
        return;
      }
      if (body.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (body.method === "tools/list") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          'event: message\ndata: {"jsonrpc":"2.0","id":' +
            body.id +
            ',"result":{"tools":[{"name":"search","description":"Search","inputSchema":{"type":"object"}}]}}\n\n',
        );
        return;
      }
      if (body.method === "tools/call") {
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
  return `http://127.0.0.1:${address.port}/mcp`;
}

afterEach(async () => {
  behaviour = "normal";
  seen = [];
  seq = 0;
  revoked.clear();
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe("mcp client", () => {
  it("initializes once, then carries the session and version on every request", async () => {
    const url = await start();
    const client = createMcpClient({ url });
    const tools = await client.listTools();
    expect(tools.ok).toBe(true);
    if (tools.ok) expect(tools.value[0]!.name).toBe("search");

    expect(seen.map((entry) => entry.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(seen[0]!.version).toBe(MCP_PROTOCOL_VERSION);
    expect(seen[2]!.session).toBe("sess_1");
    expect(seen[2]!.version).toBe(MCP_PROTOCOL_VERSION);
    expect(seen[2]!.accept).toContain("text/event-stream");
  });

  it("returns the text a tools/call produced", async () => {
    const url = await start();
    const client = createMcpClient({ url });
    const result = await client.callTool("search", { q: "x" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("found 3 things");
  });

  it("re-initializes once when the server says the session expired", async () => {
    const url = await start();
    const client = createMcpClient({ url });
    await client.listTools();
    seen = [];
    behaviour = "expired";
    // The server restarted and forgot the session the client is holding.
    revoked.add(client.sessionId()!);
    const result = await client.listTools();
    expect(result.ok).toBe(true);
    // The revoked session fails, so the client re-handshakes and tries again.
    expect(seen.map((entry) => entry.method)).toEqual([
      "tools/list",
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });

  it("reports 401 as unauthorized and does not retry", async () => {
    const url = await start();
    const client = createMcpClient({ url });
    behaviour = "unauthorized";
    const result = await client.listTools();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unauthorized");
      expect(result.error.retryable).toBe(false);
    }
    expect(seen.filter((entry) => entry.method === "initialize")).toHaveLength(1);
  });

  it("reports a 500 as a retryable network error", async () => {
    const url = await start();
    const client = createMcpClient({ url });
    behaviour = "broken";
    const result = await client.listTools();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("network_error");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("times out without throwing", async () => {
    const url = await start();
    const client = createMcpClient({ url, timeoutMs: 50 });
    behaviour = "slow";
    const result = await client.listTools();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("timeout");
  });
});
