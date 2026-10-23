import { createHash } from "node:crypto";
import { searchWithFallback, resolveSearchProvider } from "@/lib/connectors/registry";
import type { ConnectorErrorCode, SearchHit } from "@/lib/connectors/types";
import { SEARCH_RESULT_LIMIT, SEARCH_TIMEOUT_MS } from "@/lib/connectors/types";
import type { ToolStepStatus } from "@/lib/domain/tool-plan";
import { db } from "@/lib/db";
import { evidence } from "@/lib/db/schema";
import { newId } from "@/lib/ids";

export type PersistedEvidence = {
  id: string;
  url: string;
  title: string;
  publisher: string | null;
  quote: string;
  /** `search_summary` or `page_extract`; the model is told which. */
  kind: string;
  retrievedAt: string;
};

export type SearchEvidenceResult = {
  status: ToolStepStatus;
  provider: string | null;
  latencyMs: number;
  query: string;
  hits: SearchHit[];
  evidence: PersistedEvidence[];
  message: string | null;
};

const ERROR_STATUS: Record<ConnectorErrorCode, ToolStepStatus> = {
  not_configured: "not_connected",
  unauthorized: "unauthorized",
  rate_limited: "rate_limited",
  timeout: "timeout",
  invalid_response: "invalid_response",
  network_error: "invalid_response",
};

/**
 * Run the search the tool step asked for, then persist every citable hit.
 *
 * Evidence is written even when the model later fails: the Auditor's question
 * is "what was actually retrieved", and a failed run is still a record.
 */
export async function searchAndPersist(input: {
  userId: string;
  taskId: string;
  runId: string;
  query: string;
  limit?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<SearchEvidenceResult> {
  const query = input.query.trim();
  const limit = input.limit ?? SEARCH_RESULT_LIMIT;

  if (!query) {
    return {
      status: "invalid_response",
      provider: null,
      latencyMs: 0,
      query,
      hits: [],
      evidence: [],
      message: "任务没有可用于检索的标题或描述。",
    };
  }

  if (!resolveSearchProvider()) {
    return {
      status: "not_connected",
      provider: null,
      latencyMs: 0,
      query,
      hits: [],
      evidence: [],
      message:
        "没有配置检索连接器（BRAVE_API_KEY / TAVILY_API_KEY），本次没有获取任何外部来源。",
    };
  }

  const outcome = await searchWithFallback({
    query,
    limit,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs ?? SEARCH_TIMEOUT_MS,
  });

  if (!outcome.ok) {
    return {
      status: ERROR_STATUS[outcome.error.code],
      provider: outcome.provider === "none" ? null : outcome.provider,
      latencyMs: outcome.latencyMs,
      query,
      hits: [],
      evidence: [],
      message: outcome.error.message,
    };
  }

  if (outcome.hits.length === 0) {
    return {
      status: "invalid_response",
      provider: outcome.provider,
      latencyMs: outcome.latencyMs,
      query,
      hits: [],
      evidence: [],
      message: "连接器返回了结果，但没有一条可以引用（缺 URL 或缺少原文摘要）。",
    };
  }

  const retrievedAt = new Date();
  const rows = outcome.hits.map((hit) => ({
    id: newId("evd"),
    userId: input.userId,
    taskId: input.taskId,
    runId: input.runId,
    // A search hit is a provider-written snippet, not the page itself.
    kind: "search_summary",
    url: hit.url,
    title: hit.title,
    publisher: hit.publisher,
    quote: hit.quote,
    provider: outcome.provider,
    contentHash: createHash("sha256")
      .update(`${hit.url}\u0000${hit.quote}`)
      .digest("hex"),
    retrievedAt,
  }));

  await db.insert(evidence).values(rows);

  return {
    status: "ok",
    provider: outcome.provider,
    latencyMs: outcome.latencyMs,
    query,
    hits: outcome.hits,
    evidence: rows.map((row) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      publisher: row.publisher,
      quote: row.quote,
      kind: row.kind,
      retrievedAt: retrievedAt.toISOString(),
    })),
    message: null,
  };
}
