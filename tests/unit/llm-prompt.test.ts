import { describe, expect, it } from "vitest";
import {
  composeEvidenceBlock,
  composeSystemPrompt,
  composeUserPrompt,
  type PromptInput,
} from "@/lib/llm";

const base: PromptInput = {
  agentName: "Mira",
  role: "coach",
  charter: "我负责让你真的学会。",
  taskTitle: "阅读 RAG 检索章节",
  taskDescription: "先看例子，再看定义。",
  acceptanceCriteria: "3 行笔记。",
  memories: ["上周做过一次检索练习"],
};

describe("composeSystemPrompt", () => {
  it("stays the same when there is no skill and no rule", () => {
    const prompt = composeSystemPrompt(base);
    expect(prompt).toContain("你是 Mira（coach）。");
    expect(prompt).toContain("你的宪章：我负责让你真的学会。");
    expect(prompt).not.toContain("你已通过考核的技能");
    expect(prompt).not.toContain("用户的长期要求");
  });

  it("turns a passed skill's steps into numbered instructions", () => {
    // A skill used to be a badge on the cabinet page: the prompt never saw it,
    // so passing the exam changed nothing about the work.
    const prompt = composeSystemPrompt({
      ...base,
      skills: [{ name: "检索评估练习设计", steps: ["读运行", "出题", "写评分标准"] }],
    });
    expect(prompt).toContain("- 检索评估练习设计：1) 读运行 2) 出题 3) 写评分标准");
  });

  it("lists the user's rules verbatim, above the citation rules", () => {
    const prompt = composeSystemPrompt({
      ...base,
      rules: ["讲解先给例子，再给定义", "别在 21:30 之后安排任务"],
    });
    expect(prompt).toContain(
      "- 讲解先给例子，再给定义\n- 别在 21:30 之后安排任务",
    );
    // Rules are user instructions: they must come before the model reaches the
    // output-format section, not buried after it.
    expect(prompt.indexOf("用户的长期要求")).toBeLessThan(
      prompt.indexOf("如果任务要求评分标准"),
    );
  });

  it("skips a skill whose steps were never written", () => {
    const prompt = composeSystemPrompt({
      ...base,
      skills: [{ name: "空技能", steps: [] }],
    });
    expect(prompt).not.toContain("空技能");
  });
});

describe("composeEvidenceBlock", () => {
  it("says there is nothing rather than inventing a source", () => {
    expect(composeEvidenceBlock([])).toBe("无");
  });

  it("fences and truncates retrieved text", () => {
    const block = composeEvidenceBlock([
      {
        id: "evd_1",
        title: "RAG 检索",
        url: "https://example.org/rag",
        publisher: null,
        quote: "甲".repeat(500),
        kind: "page_extract",
      },
    ]);
    expect(block).toContain("id=[cite:evd_1] (页面原文)");
    expect(block).toContain("摘录开始>>>");
    expect(block).toContain("…");
    expect(block.length).toBeLessThan(600);
  });
});

describe("composeUserPrompt", () => {
  it("carries the task, the bar and the memories", () => {
    const prompt = composeUserPrompt(base);
    expect(prompt).toContain("任务：阅读 RAG 检索章节");
    expect(prompt).toContain("验收标准：3 行笔记。");
    expect(prompt).toContain("可用记忆：上周做过一次检索练习");
  });

  it("says 无 when there is no memory", () => {
    expect(composeUserPrompt({ ...base, memories: [] })).toContain(
      "可用记忆：无",
    );
  });
});
