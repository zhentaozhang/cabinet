import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

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
}): Promise<ArtifactDraft | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

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
      model: provider(process.env.OPENAI_MODEL ?? "gpt-4.1-mini"),
      abortSignal: controller.signal,
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

    if (!text.trim()) return null;

    return {
      title: `${input.taskTitle} · ${input.agentName}`,
      content: text,
      tokensIn: usage?.inputTokens ?? 0,
      tokensOut: usage?.outputTokens ?? 0,
    };
  } catch {
    return null;
  }
}
