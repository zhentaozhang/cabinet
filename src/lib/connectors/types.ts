/**
 * Shared connector contract.
 *
 * A connector is allowed to fail, and it must say *how* it failed: the caller
 * records the code on the run and the Auditor decides with it. Nothing here
 * throws for provider conditions — only programming errors throw.
 */

export type ConnectorErrorCode =
  | "not_configured"
  | "unauthorized"
  | "rate_limited"
  | "timeout"
  | "invalid_response"
  | "network_error";

export type ConnectorError = {
  code: ConnectorErrorCode;
  message: string;
  /** Whether a later attempt could plausibly succeed. */
  retryable: boolean;
};

/** A single retrieved source. `quote` is verbatim provider text. */
export type SearchHit = {
  url: string;
  title: string;
  quote: string;
  publisher: string | null;
};

export type SearchOutcome =
  | {
      ok: true;
      provider: string;
      latencyMs: number;
      hits: SearchHit[];
    }
  | {
      ok: false;
      provider: string;
      latencyMs: number;
      error: ConnectorError;
    };

export type SearchRequest = {
  query: string;
  limit: number;
  /** Injected in tests so no suite ever touches the network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export const SEARCH_TIMEOUT_MS = 8_000;
export const SEARCH_RESULT_LIMIT = 5;
