import { describe, expect, it } from "vitest";
import {
  checklistPassed,
  evaluateAcceptance,
} from "@/lib/domain/acceptance";

describe("acceptance checklist", () => {
  it("evaluates each supported criterion deterministically", () => {
    const content = `# 检索评估练习

## 评分标准
| 维度 | 分数 |
| --- | ---: |
| recall | 2 |

来源：https://arxiv.org/abs/2312.10997
来源：https://example.com/rag`;

    const results = evaluateAcceptance(content, [
      { type: "section", value: "评分标准", required: true },
      { type: "contains", value: "recall", required: true },
      { type: "min_words", value: 5, required: true },
      { type: "min_sources", value: 2, required: true },
      { type: "manual", note: "人工复核引用", required: false },
    ]);

    expect(results.every((result) => result.passed)).toBe(true);
    expect(checklistPassed(results)).toBe(true);
  });

  it("fails only the criteria that are actually missing", () => {
    const results = evaluateAcceptance("只有一句话。", [
      { type: "section", value: "评分标准", required: true },
      { type: "min_words", value: 50, required: true },
      { type: "manual", note: "可选复核", required: false },
    ]);

    expect(results[0].passed).toBe(false);
    expect(results[1].passed).toBe(false);
    expect(checklistPassed(results)).toBe(false);
  });

  it("does not let an optional failure reject a submission", () => {
    const results = evaluateAcceptance("有内容。", [
      { type: "min_words", value: 100, required: false },
    ]);
    expect(results[0].passed).toBe(false);
    expect(checklistPassed(results)).toBe(true);
  });
});
