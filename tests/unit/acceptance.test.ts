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

  it("does not accept hallucinated URLs as evidence", () => {
    // Two real-looking links, but nothing was fetched, so nothing is persisted.
    const content =
      "结论见 https://example.com/a 和 https://example.org/b 。";
    const withLinks = evaluateAcceptance(content, [
      { type: "min_sources", value: 2, required: true },
    ]);
    expect(withLinks[0].passed).toBe(true);
    // The wording must say it only counted links, not verified them.
    expect(withLinks[0].reason).toContain("未验证可达性");

    const asEvidence = evaluateAcceptance(
      content,
      [{ type: "min_evidence", value: 2, required: true }],
      { evidenceCount: 0 },
    );
    expect(asEvidence[0].passed).toBe(false);
    expect(asEvidence[0].reason).toContain("正文里的链接不算证据");
    expect(checklistPassed(asEvidence)).toBe(false);
  });

  it("passes min_evidence only with persisted rows", () => {
    const results = evaluateAcceptance(
      "有来源的结论。",
      [{ type: "min_evidence", value: 2, required: true }],
      { evidenceCount: 3 },
    );
    expect(results[0].passed).toBe(true);
  });

  it("treats a missing evidence context as zero evidence", () => {
    const results = evaluateAcceptance("有来源的结论。", [
      { type: "min_evidence", value: 1, required: true },
    ]);
    expect(results[0].passed).toBe(false);
  });
});
