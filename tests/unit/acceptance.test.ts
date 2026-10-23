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

    const rules = results.filter((result) => result.item.type !== "manual");
    expect(rules.every((result) => result.passed)).toBe(true);
    // A manual item is never auto-passed: it waits for the user.
    const manual = results.find((result) => result.item.type === "manual")!;
    expect(manual.passed).toBe(false);
    expect(manual.undetermined).toBe(true);
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

describe("undetermined rules", () => {
  it("never turns a manual item green, but does not fail the checklist", () => {
    const results = evaluateAcceptance("产物内容足够长，足以通过字数检查。", [
      { type: "min_words", value: 5, required: true },
      { type: "manual", note: "引用是否支持结论", required: true },
    ]);

    expect(checklistPassed(results)).toBe(true);
    const manual = results[1];
    expect(manual.undetermined).toBe(true);
    expect(manual.passed).toBe(false);
    expect(manual.reason).toContain("不代判");
  });

  it("treats an evidence rule over a hand-submitted artifact as pending review", () => {
    const results = evaluateAcceptance("人工写的调研笔记，没有任何 [cite:…] 标记。", [
      { type: "min_evidence", value: 3, required: true },
    ], { evidenceApplicable: false, evidenceCount: 0, evidenceIds: new Set() });

    expect(results[0].undetermined).toBe(true);
    expect(results[0].passed).toBe(false);
    expect(results[0].reason).toContain("人工复核");
    expect(checklistPassed(results)).toBe(true);
  });

  it("still fails an evidence rule when the artifact came from a run", () => {
    const results = evaluateAcceptance("没有引用。", [
      { type: "min_evidence", value: 3, required: true },
    ], { evidenceApplicable: true, evidenceCount: 0, evidenceIds: new Set() });

    expect(results[0].undetermined).toBeUndefined();
    expect(results[0].passed).toBe(false);
    expect(checklistPassed(results)).toBe(false);
  });
});

describe("claims table rule", () => {
  const table = [
    "| 主张 | 引用 | 是否被原文支持 |",
    "| --- | --- | --- |",
    "| A | [cite:evd_1] |  |",
    "| B | [cite:evd_2] |  |",
    "| C | [cite:evd_3] |  |",
  ].join("\n");

  it("passes the format and still asks a human to judge support", () => {
    const [result] = evaluateAcceptance(
      table,
      [{ type: "claims_table", value: 3, required: true }],
      { evidenceIds: new Set(["evd_1", "evd_2", "evd_3"]) },
    );
    expect(result.passed).toBe(false);
    expect(result.undetermined).toBe(true);
    expect(result.reason).toContain("格式合格");
  });

  it("fails outright when a cited row was never stored", () => {
    const [result] = evaluateAcceptance(
      table.replace("evd_2", "evd_missing"),
      [{ type: "claims_table", value: 3, required: true }],
      { evidenceIds: new Set(["evd_1", "evd_3"]) },
    );
    expect(result.passed).toBe(false);
    expect(result.undetermined).toBeFalsy();
    expect(result.reason).toContain("引用了不存在的证据");
  });
});
