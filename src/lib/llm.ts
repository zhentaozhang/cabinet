import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

export type ArtifactDraft = {
  title: string;
  content: string;
  tokensIn: number;
  tokensOut: number;
};

export type ModelExecutionResult =
  | { status: "success"; draft: ArtifactDraft }
  | { status: "not_configured" }
  | { status: "timeout" }
  | { status: "provider_error"; error: string }
  | { status: "empty_response" };

/**
 * Server-side model call. A missing key or provider failure is returned as a
 * typed non-success result; callers must not replace it with a template
 * artifact in a real workspace.
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
}): Promise<ModelExecutionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { status: "not_configured" };

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
      model: provider(process.env.OPENAI_MODEL ?? "gpt-4.1-mini"),
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
    });

    if (!text.trim()) return { status: "empty_response" };

    return {
      status: "success",
      draft: {
        title: `${input.taskTitle} · ${input.agentName}`,
        content: text,
        tokensIn: usage?.inputTokens ?? 0,
        tokensOut: usage?.outputTokens ?? 0,
      },
    };
  } catch (error) {
    if (controller.signal.aborted) return { status: "timeout" };
    return {
      status: "provider_error",
      // Keep the category safe; provider payloads can contain request details.
      error: error instanceof Error ? error.name : "provider_error",
    };
  } finally {
    clearTimeout(timer);
  }
}
