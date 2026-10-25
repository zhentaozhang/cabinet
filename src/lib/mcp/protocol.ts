/**
 * The minimum of MCP that Cabinet needs, written by hand.
 *
 * Only Streamable HTTP is implemented: a POST carrying one JSON-RPC message,
 * answered with either `application/json` or `text/event-stream`. stdio is out
 * of scope on purpose — spawning a subprocess cannot be tested in-process and
 * would mean shipping arbitrary executables as "configuration".
 */

/** The revision this client speaks. Sent on `initialize` and on every later POST. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export function jsonRpcRequest(
  method: string,
  params: unknown,
  id: JsonRpcId,
): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
}

export function jsonRpcNotification(
  method: string,
  params?: unknown,
): JsonRpcNotification {
  return params === undefined
    ? { jsonrpc: "2.0", method }
    : { jsonrpc: "2.0", method, params };
}

export type ParsedResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: number; message: string } };

/**
 * Parse one JSON-RPC response envelope.
 *
 * Never throws: a 502 HTML page, an empty body and a `null` all have to become
 * "the server said nothing usable", because the caller records that as
 * `invalid_response` rather than crashing a run.
 */
export function parseJsonRpcResponse(
  text: string,
  expectedId?: JsonRpcId,
): ParsedResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: { code: 0, message: "Response was not JSON." } };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: { code: 0, message: "Response was not an object." } };
  }
  const envelope = parsed as {
    id?: unknown;
    result?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  // A reply is only an answer to *this* request. Without this check any body
  // that happens to parse — a retried earlier call, a broadcast, another
  // client's response — is accepted as the result (5f332e7f 建议 2).
  if (expectedId !== undefined && envelope.id !== expectedId) {
    return {
      ok: false,
      error: {
        code: 0,
        message: "Response id did not match the request id.",
      },
    };
  }
  if (envelope.error) {
    return {
      ok: false,
      error: {
        code: typeof envelope.error.code === "number" ? envelope.error.code : 0,
        message:
          typeof envelope.error.message === "string"
            ? envelope.error.message
            : "Server reported an error without a message.",
      },
    };
  }
  if (!("result" in envelope)) {
    return { ok: false, error: { code: 0, message: "Response carried no result." } };
  }
  return { ok: true, result: envelope.result };
}

/**
 * Pull the `data:` payloads out of a server-sent-events body, in order.
 *
 * Streamable HTTP may answer a POST with a short SSE stream instead of JSON.
 * Comments (`: ping`) are keep-alives, not messages.
 */
export function parseSseMessages(body: string): string[] {
  const messages: string[] = [];
  let data: string[] = [];

  const flush = () => {
    if (data.length > 0) messages.push(data.join("\n"));
    data = [];
  };

  for (const rawLine of body.split(/\r?\n/)) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    if (field !== "data") continue;
    const value = colon === -1 ? "" : rawLine.slice(colon + 1);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  flush();
  return messages;
}

export type ToolResult =
  | { ok: true; content: string }
  | { ok: false; code: "invalid_response"; message: string };

/**
 * Turn a `tools/call` result into the text a step records.
 *
 * `isError: true` is the server saying the call failed while the transport
 * succeeded — recording its text as content would show a quota message to the
 * user as if it were an answer.
 */
export function extractToolResult(result: unknown): ToolResult {
  if (!result || typeof result !== "object") {
    return { ok: false, code: "invalid_response", message: "Tool result was not an object." };
  }
  const envelope = result as { content?: unknown; isError?: unknown };
  const parts = Array.isArray(envelope.content) ? envelope.content : [];
  const texts = parts
    .map((part) => {
      if (!part || typeof part !== "object") return null;
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? candidate.text
        : null;
    })
    .filter((text): text is string => text !== null);

  if (envelope.isError === true) {
    return {
      ok: false,
      code: "invalid_response",
      message: texts.join("\n") || "Tool reported an error without a message.",
    };
  }
  if (texts.length === 0) {
    return {
      ok: false,
      code: "invalid_response",
      message: "Tool returned no text content.",
    };
  }
  return { ok: true, content: texts.join("\n") };
}
