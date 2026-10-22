import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

import { logEvent } from "@/lib/obs/context";
import { serialiseError } from "@/lib/obs/logger";

export type ArtifactDraft = {
  title: string;
  content: string;
  tokensIn: number;
  tokensOut: number;
};

/**
 * Optional live-model path. When OPENAI_API_KEY is missing the runtime falls
 * back to deterministic demo output, so the product is always demoable.
 */
export async function generateArtifact(input: {
  agentName: string;
  role: string;
  charter: string;
  taskTitle: string;
  taskDescription: string;
  acceptanceCriteria: string;
  memories: string[];
  maxOutputTokens: number;
}): Promise<ArtifactDraft | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Explicitly "not configured", never confused with "configured but failing".
    logEvent("debug", "llm.skipped", { reason: "missing_key", mode: "demo" });
    return null;
  }

  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const startedAt = Date.now();

  try {
    const provider = createOpenAI({
      apiKey,
      ...(process.env.OPENAI_BASE_URL
        ? { baseURL: process.env.OPENAI_BASE_URL }
        : {}),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const { text, usage } = await generateText({
      model: provider(model),
      abortSignal: controller.signal,
      maxOutputTokens: input.maxOutputTokens,
      temperature: 0.2,
      system: [
        `你是 ${input.agentName}（${input.role}）。`,
        `你的宪章：${input.charter}`,
        "只输出 Markdown，不要解释你是谁。",
        "如果任务要求评分标准，必须包含 `## 评分标准` 和评分表。",
      ].join("\n"),
      prompt: [
        `任务：${input.taskTitle}`,
        `描述：${input.taskDescription}`,
        `验收标准：${input.acceptanceCriteria}`,
        `可用记忆：${input.memories.join("；") || "无"}`,
        "请产出一份可验收的 Markdown 产物。",
      ].join("\n"),
    }).finally(() => clearTimeout(timer));

    if (!text.trim()) {
      logEvent("warn", "llm.empty_output", {
        model,
        outcome: "empty",
        durMs: Date.now() - startedAt,
      });
      return null;
    }

    const tokensIn = usage?.inputTokens ?? 0;
    const tokensOut = usage?.outputTokens ?? 0;

    logEvent("info", "llm.call", {
      model,
      outcome: "ok",
      tokensIn,
      tokensOut,
      durMs: Date.now() - startedAt,
    });

    return {
      title: `${input.taskTitle} · ${input.agentName}`,
      content: text,
      tokensIn,
      tokensOut,
    };
  } catch (error) {
    // Before this event existed, a configured-but-broken provider produced the
    // same `mode: "demo"` artifact as a provider that was never configured.
    // The reason is the whole point of logging here.
    logEvent("warn", "llm.fallback", {
      ...serialiseError(error),
      model,
      outcome: "fallback",
      fallbackReason: fallbackReason(error),
      durMs: Date.now() - startedAt,
    });
    return null;
  }
}

const AUTH_STATUSES = new Set([401, 403]);
const RATE_LIMIT_STATUS = 429;

/**
 * A bounded vocabulary, so a future `cabinet_llm_fallback_total{reason}` stays
 * aggregable instead of exploding into one series per provider error string.
 */
function fallbackReason(error: unknown): string {
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return "timeout";
  }

  const candidate = error as { statusCode?: unknown; status?: unknown } | null;
  const raw = candidate?.statusCode ?? candidate?.status;
  const status = typeof raw === "number" ? raw : null;

  if (status !== null) {
    if (AUTH_STATUSES.has(status)) return "auth";
    if (status === RATE_LIMIT_STATUS) return "rate_limited";
    if (status >= 500) return "upstream_error";
    if (status >= 400) return "client_error";
  }

  return "unknown";
}
