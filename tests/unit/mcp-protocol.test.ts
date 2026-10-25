import { describe, expect, it } from "vitest";
import {
  MCP_PROTOCOL_VERSION,
  extractToolResult,
  jsonRpcNotification,
  jsonRpcRequest,
  parseJsonRpcResponse,
  parseSseMessages,
} from "@/lib/mcp/protocol";

describe("json-rpc framing", () => {
  it("builds a request with the protocol's own envelope", () => {
    expect(jsonRpcRequest("tools/call", { name: "search", arguments: { q: "x" } }, 7)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "search", arguments: { q: "x" } },
    });
  });

  it("builds a notification without an id, because nothing answers it", () => {
    expect(jsonRpcNotification("notifications/initialized")).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
  });

  it("pins the version this client speaks", () => {
    expect(MCP_PROTOCOL_VERSION).toBe("2025-06-18");
  });
});

describe("json-rpc responses", () => {
  it("reads a result", () => {
    const parsed = parseJsonRpcResponse('{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}');
    expect(parsed).toEqual({ ok: true, result: { tools: [] } });
  });

  it("reads an error, keeping the server's code and message", () => {
    const parsed = parseJsonRpcResponse(
      '{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"Method not found"}}',
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe(-32601);
      expect(parsed.error.message).toContain("Method not found");
    }
  });

  it("reports unparseable bodies instead of throwing", () => {
    expect(parseJsonRpcResponse("<html>502</html>").ok).toBe(false);
    expect(parseJsonRpcResponse("null").ok).toBe(false);
  });
});

describe("sse bodies", () => {
  it("returns one message per event", () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
    expect(parseSseMessages(body)).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']);
  });

  it("ignores keep-alive comments and blank lines", () => {
    const body = ": ping\n\n: ping\n\n";
    expect(parseSseMessages(body)).toEqual([]);
  });

  it("keeps the order of several events", () => {
    const body =
      'data: {"id":1}\n\n' + 'event: message\ndata: {"id":2}\n\n' + 'data: {"id":3}\n\n';
    expect(parseSseMessages(body)).toEqual(['{"id":1}', '{"id":2}', '{"id":3}']);
  });
});

describe("tool results", () => {
  it("joins text parts into the content the run records", () => {
    const result = extractToolResult({
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    });
    expect(result).toEqual({ ok: true, content: "line one\nline two" });
  });

  it("treats isError as a failed call, not as content", () => {
    const result = extractToolResult({
      isError: true,
      content: [{ type: "text", text: "quota exceeded" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_response");
      expect(result.message).toContain("quota exceeded");
    }
  });

  it("rejects a result with no text at all", () => {
    expect(extractToolResult({ content: [{ type: "image", data: "…" }] }).ok).toBe(false);
    expect(extractToolResult({}).ok).toBe(false);
    expect(extractToolResult(null).ok).toBe(false);
  });
});
