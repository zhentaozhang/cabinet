import { createHash } from "node:crypto";
import { fetchPage, pageHit } from "@/lib/connectors/page";
import type { ConnectorErrorCode, SearchHit } from "@/lib/connectors/types";
import type { ToolStepStatus } from "@/lib/domain/tool-plan";
import { db } from "@/lib/db";
import { evidence } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import type { PersistedEvidence } from "./search";

export type PageEvidenceResult = {
  status: ToolStepStatus;
  provider: string | null;
  latencyMs: number;
  url: string;
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
 * Fetch one URL named by the task and persist it as evidence.
 *
 * `web_fetch` used to run a keyword search and call it a fetch. This is the real
 * thing: one URL in, one page out, quoted verbatim so a reader can check it.
 */
export async function fetchAndPersist(input: {
  userId: string;
  taskId: string;
  runId: string;
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<PageEvidenceResult> {
  const outcome = await fetchPage({
    url: input.url,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
  });

  if (!outcome.ok) {
    return {
      status: ERROR_STATUS[outcome.error.code],
      provider: "fetch",
      latencyMs: outcome.latencyMs,
      url: input.url,
      hits: [],
      evidence: [],
      message: outcome.error.message,
    };
  }

  const hit = pageHit(outcome);
  const row = {
    id: newId("evd"),
    userId: input.userId,
    taskId: input.taskId,
    runId: input.runId,
    kind: "web_page",
    url: hit.url,
    title: hit.title,
    publisher: hit.publisher,
    quote: hit.quote,
    provider: "fetch",
    contentHash: createHash("sha256")
      .update(`${hit.url}\u0000${hit.quote}`)
      .digest("hex"),
    retrievedAt: new Date(),
  };

  await db.insert(evidence).values(row);

  return {
    status: "ok",
    provider: "fetch",
    latencyMs: outcome.latencyMs,
    url: hit.url,
    hits: [hit],
    evidence: [
      {
        id: row.id,
        url: row.url,
        title: row.title,
        publisher: row.publisher,
        quote: row.quote,
        retrievedAt: row.retrievedAt.toISOString(),
      },
    ],
    message: `抓取了 ${hit.publisher ?? hit.url} 的正文，已落库 1 条证据。`,
  };
}
