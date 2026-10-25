/**
 * A governed MCP client over Streamable HTTP.
 *
 * Every outcome is a value, never an exception: a run records what happened to
 * a tool call, so a dead server has to arrive as `timeout`/`network_error`
 * rather than as a stack trace that aborts the run.
 */
import type { ConnectorErrorCode } from "@/lib/connectors/types";
import {
  MCP_PROTOCOL_VERSION,
  extractToolResult,
  jsonRpcNotification,
  jsonRpcRequest,
  parseJsonRpcResponse,
  parseSseMessages,
  type JsonRpcId,
} from "./protocol";

const DEFAULT_TIMEOUT_MS = 8_000;
const SESSION_HEADER = "mcp-session-id";
const PROTOCOL_HEADER = "mcp-protocol-version";
const ACCEPT = "application/json, text/event-stream";

export type McpToolSpec = {
  name: string;
  description: string;
  inputSchema: unknown;
};

export type McpError = {
  code: ConnectorErrorCode;
  message: string;
  retryable: boolean;
};

export type McpOutcome<T> =
  | { ok: true; latencyMs: number; value: T }
  | { ok: false; latencyMs: number; error: McpError };

export type McpClient = {
  initialize(): Promise<McpOutcome<null>>;
  listTools(): Promise<McpOutcome<McpToolSpec[]>>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpOutcome<string>>;
  sessionId(): string | null;
  close(): void;
};

export type McpClientOptions = {
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
};

type RawResponse = {
  status: number;
  text: string;
  contentType: string;
  session: string | null;
};

export function createMcpClient(options: McpClientOptions): McpClient {
  const url = options.url;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clientName = options.clientName ?? "cabinet";
  const clientVersion = options.clientVersion ?? "1";

  let session: string | null = null;
  let nextId = 0;
  let initialising: Promise<McpOutcome<null>> | null = null;

  async function send(body: unknown): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: ACCEPT,
        [PROTOCOL_HEADER]: MCP_PROTOCOL_VERSION,
      };
      if (session) headers[SESSION_HEADER] = session;
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const returned = response.headers.get(SESSION_HEADER);
      if (returned) session = returned;
      return {
        status: response.status,
        text,
        contentType: response.headers.get("content-type") ?? "",
        session,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function failed(latencyMs: number, error: McpError): { ok: false; latencyMs: number; error: McpError } {
    return { ok: false, latencyMs, error };
  }

  function transportError(error: unknown): McpError {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      code: aborted ? "timeout" : "network_error",
      message: aborted
        ? `MCP server did not answer within ${timeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : "MCP request failed.",
      retryable: true,
    };
  }

  function statusError(response: RawResponse): McpError | null {
    if (response.status === 401 || response.status === 403) {
      return {
        code: "unauthorized",
        message: `MCP server rejected the request (HTTP ${response.status}).`,
        retryable: false,
      };
    }
    if (response.status === 429) {
      return {
        code: "rate_limited",
        message: "MCP server is rate limiting this client.",
        retryable: true,
      };
    }
    if (response.status === 408 || response.status === 504) {
      return { code: "timeout", message: `MCP server timed out (HTTP ${response.status}).`, retryable: true };
    }
    if (response.status >= 500) {
      return {
        code: "network_error",
        message: `MCP server failed (HTTP ${response.status}).`,
        retryable: true,
      };
    }
    if (response.status >= 400) {
      return {
        code: "invalid_response",
        message: `MCP server rejected the request (HTTP ${response.status}).`,
        retryable: false,
      };
    }
    return null;
  }

  function pickMessage(response: RawResponse, id: JsonRpcId): string | null {
    if (response.contentType.includes("text/event-stream")) {
      const messages = parseSseMessages(response.text);
      if (messages.length === 0) return null;
      for (const message of messages) {
        try {
          const parsed = JSON.parse(message) as { id?: unknown };
          if (parsed.id === id) return message;
        } catch {
          // Keep looking: one unparseable event should not hide the answer.
        }
      }
      return messages[messages.length - 1]!;
    }
    return response.text.trim() === "" ? null : response.text;
  }

  async function rpc<T>(
    method: string,
    params: unknown,
    parse: (result: unknown) => { ok: true; value: T } | { ok: false; message: string },
  ): Promise<McpOutcome<T>> {
    const started = Date.now();
    try {
      // A session can expire between two calls; the server signals that with
      // HTTP 404, so the handshake is redone once before giving up.
      for (let attempt = 0; ; attempt += 1) {
        const ready = await ensureInitialized();
        if (!ready.ok) return ready as McpOutcome<T>;

        const id = (nextId += 1);
        const response = await send(jsonRpcRequest(method, params, id));
        if (response.status === 404 && session && attempt === 0) {
          session = null;
          continue;
        }
        const failure = statusError(response);
        if (failure) return failed(Date.now() - started, failure);
        const message = pickMessage(response, id);
        if (message === null) {
          return failed(Date.now() - started, {
            code: "invalid_response",
            message: "MCP server returned an empty response.",
            retryable: false,
          });
        }
        const parsed = parseJsonRpcResponse(message);
        if (!parsed.ok) {
          return failed(Date.now() - started, {
            code: "invalid_response",
            message: parsed.error.message,
            retryable: false,
          });
        }
        const value = parse(parsed.result);
        if (!value.ok) {
          return failed(Date.now() - started, {
            code: "invalid_response",
            message: value.message,
            retryable: false,
          });
        }
        return { ok: true, latencyMs: Date.now() - started, value: value.value };
      }
    } catch (error) {
      return failed(Date.now() - started, transportError(error));
    }
  }

  async function ensureInitialized(): Promise<McpOutcome<null>> {
    if (session) return { ok: true, latencyMs: 0, value: null };
    if (!initialising) {
      initialising = doInitialize().finally(() => {
        initialising = null;
      });
    }
    return initialising;
  }

  async function doInitialize(): Promise<McpOutcome<null>> {
    const started = Date.now();
    try {
      const id = (nextId += 1);
      const response = await send(
        jsonRpcRequest(
          "initialize",
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: clientName, version: clientVersion },
          },
          id,
        ),
      );
      const failure = statusError(response);
      if (failure) return { ok: false, latencyMs: Date.now() - started, error: failure };
      const message = pickMessage(response, id);
      const parsed = message === null ? { ok: false as const } : parseJsonRpcResponse(message);
      if (!parsed.ok) {
        return failed(Date.now() - started, {
          code: "invalid_response",
          message: "MCP server did not complete the initialize handshake.",
          retryable: false,
        });
      }
      if (!response.session) {
        return failed(Date.now() - started, {
          code: "invalid_response",
          message: "MCP server did not return a session id.",
          retryable: false,
        });
      }
      // The handshake is only complete once the server is told so.
      const ack = await send(jsonRpcNotification("notifications/initialized"));
      if (statusError(ack)) {
        const ackFailure = statusError(ack)!;
        return failed(Date.now() - started, ackFailure);
      }
      return { ok: true, latencyMs: Date.now() - started, value: null };
    } catch (error) {
      return failed(Date.now() - started, transportError(error));
    }
  }

  return {
    async initialize() {
      session = null;
      return ensureInitialized();
    },

    async listTools() {
      return rpc("tools/list", {}, (result) => {
        const tools = (result as { tools?: unknown })?.tools;
        if (!Array.isArray(tools)) {
          return { ok: false as const, message: "MCP server returned no tool list." };
        }
        const specs: McpToolSpec[] = [];
        for (const entry of tools) {
          if (!entry || typeof entry !== "object") continue;
          const tool = entry as { name?: unknown; description?: unknown; inputSchema?: unknown };
          if (typeof tool.name !== "string" || tool.name === "") continue;
          specs.push({
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description : "",
            inputSchema: tool.inputSchema ?? { type: "object" },
          });
        }
        return { ok: true as const, value: specs };
      });
    },

    async callTool(name, args) {
      return rpc("tools/call", { name, arguments: args }, (result) => {
        const extracted = extractToolResult(result);
        if (!extracted.ok) {
          return { ok: false as const, message: extracted.message };
        }
        return { ok: true as const, value: extracted.content };
      });
    },

    sessionId() {
      return session;
    },

    close() {
      session = null;
    },
  };
}
