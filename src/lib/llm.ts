import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { newId } from "@/lib/ids";

export type ArtifactDraft = {
  title: string;
  content: string;
  tokensIn: number;
  tokensOut: number;
};

/** A source the model is allowed to cite, already persisted server-side. */
export type EvidenceForPrompt = {
  id: string;
  title: string;
  url: string;
  publisher: string | null;
  quote: string;
};

export type ModelExecutionResult =
  | {
      status: "success";
      /** One id per real provider call; unique across retries. */
      attemptId: string;
      provider: string;
      model: string;
      /** `actual` only when the provider reported usage for this attempt. */
      costSource: "actual" | "unknown";
      draft: ArtifactDraft;
    }
  | {
      status: "not_configured";
      attemptId: null;
    }
  | {
      status: "timeout" | "provider_error" | "empty_response";
      /** The call may have reached the provider, so usage is unknown. */
      attemptId: string;
      provider: string;
      model: string;
      costSource: "unknown";
      error?: string;
    };

/**
 * Server-side model call. A missing key or provider failure is returned as a
 * typed non-success result; callers must not replace it with a template
 * artifact in a real workspace. Every attempt carries an id so failures stay
 * attributable and are never recorded as measured zero usage.
 */
export async function generateArtifact(input: {
  agentName: string;
  role: string;
  charter: string;
  taskTitle: string;
  taskDescription: string;
  acceptanceCriteria: string;
  memories: string[];
  /** Retrieved sources the draft may cite; empty when nothing was retrieved. */
  evidence?: EvidenceForPrompt[];
  maxOutputTokens: number;
}): Promise<ModelExecutionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { status: "not_configured", attemptId: null };

  // Created before the request so a failure still keeps its attempt identity.
  const attemptId = newId("att");
  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const providerName = "openai";

  const evidence = input.evidence ?? [];
  const citationRule =
    evidence.length > 0
      ? [
          "引用规则：只能引用下面列出的来源，每处引用写成 `[cite:<id>]`。",
          "不要引用未列出的 URL，不要编造 id。",
          "无法被来源支持的说法，必须写明「无证据」。",
        ]
      : [
          "本次没有检索到任何外部来源。",
          "不要编造引用或 URL；需要证据的结论请写明「无证据」。",
        ];
  const evidenceBlock =
    evidence.length > 0
      ? evidence
          .map(
            (item) =>
              `- [cite:${item.id}] ${item.title} — ${item.url}\n  原文：${item.quote}`,
          )
          .join("\n")
      : "无";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const provider = createOpenAI({
      apiKey,
      ...(process.env.OPENAI_BASE_URL
        ? { baseURL: process.env.OPENAI_BASE_URL }
        : {}),
    });

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
        ...citationRule,
      ].join("\n"),
      prompt: [
        `任务：${input.taskTitle}`,
        `描述：${input.taskDescription}`,
        `验收标准：${input.acceptanceCriteria}`,
        `可用记忆：${input.memories.join("；") || "无"}`,
        `可用来源：\n${evidenceBlock}`,
        "请产出一份可验收的 Markdown 产物。",
      ].join("\n"),
    });

    if (!text.trim()) {
      return {
        status: "empty_response",
        attemptId,
        provider: providerName,
        model,
        costSource: "unknown",
      };
    }

    return {
      status: "success",
      attemptId,
      provider: providerName,
      model,
      // Without a reported usage the attempt happened but its cost is unknown.
      costSource: usage ? "actual" : "unknown",
      draft: {
        title: `${input.taskTitle} · ${input.agentName}`,
        content: text,
        tokensIn: usage?.inputTokens ?? 0,
        tokensOut: usage?.outputTokens ?? 0,
      },
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        status: "timeout",
        attemptId,
        provider: providerName,
        model,
        costSource: "unknown",
      };
    }
    return {
      status: "provider_error",
      attemptId,
      provider: providerName,
      model,
      costSource: "unknown",
      // Keep the category safe; provider payloads can contain request details.
      error: error instanceof Error ? error.name : "provider_error",
    };
  } finally {
    clearTimeout(timer);
  }
}
