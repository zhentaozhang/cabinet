import { describe, expect, it } from "vitest";
import {
  auditVerdict,
  checklistPassed,
  evaluateAcceptance,
  undeterminedCount,
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

    // 旧断言是 checklistPassed === true，那正是这次要修的病：required 的人工项
    // 没人判过，却让整张清单算通过。
    expect(auditVerdict(results)).toBe("needs_review");
    expect(checklistPassed(results)).toBe(false);
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
    expect(auditVerdict(results)).toBe("needs_review");
    expect(checklistPassed(results)).toBe(false);
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

describe("judge items", () => {
  it("never claims a verdict without a model, and stays pending rather than failed", () => {
    const [judge] = evaluateAcceptance("这段答案讲了闭包。", [
      { type: "judge", value: "解释闭包为什么能捕获变量", required: true },
    ]);

    expect(judge.passed).toBe(false);
    expect(judge.undetermined).toBe(true);
    expect(judge.reason).toBe("需要模型判定：解释闭包为什么能捕获变量");
    // 待判不是失败，但也绝不是通过：没有模型的环境不该因为"判不了"就驳回，
    // 同样不该因为"判不了"就把任务算成验收合格。
    expect(auditVerdict([judge])).toBe("needs_review");
    expect(checklistPassed([judge])).toBe(false);
    expect(undeterminedCount([judge])).toBe(1);
  });

  it("does not hide a deterministic failure behind a pending judge item", () => {
    const results = evaluateAcceptance("短", [
      { type: "judge", value: "解释闭包", required: true },
      { type: "min_words", value: 50, required: true },
    ]);

    expect(results[0].undetermined).toBe(true);
    expect(results[1].undetermined).toBeFalsy();
    expect(auditVerdict(results)).toBe("fail");
    expect(checklistPassed(results)).toBe(false);
  });
});

// 三值判定是这次改动的核心：从前只有一个布尔，"没有结论"被折叠进"通过"。
describe("audit verdict", () => {
  it("只会在一张清单的所有 required 项都有结论且都通过时给 pass", () => {
    const results = evaluateAcceptance("有内容。", [
      { type: "min_words", value: 1, required: true },
      { type: "contains", value: "内容", required: true },
    ]);
    expect(auditVerdict(results)).toBe("pass");
  });

  it("有 required 项被明确判否就是 fail，哪怕同时还有待判的条目", () => {
    const results = evaluateAcceptance("短", [
      { type: "min_words", value: 500, required: true },
      { type: "judge", value: "解释闭包", required: true },
    ]);
    expect(auditVerdict(results)).toBe("fail");
  });

  it("没有失败但有 required 项没结论时是 needs_review，不是 pass", () => {
    const results = evaluateAcceptance("产物内容足够长，足以通过字数检查。", [
      { type: "min_words", value: 5, required: true },
      { type: "manual", note: "引用是否支持结论", required: true },
    ]);
    expect(auditVerdict(results)).toBe("needs_review");
  });

  it("空的清单没有可判定项，判定为 pass（无清单分支由审计命令单独给出待判定）", () => {
    // 空清单是逻辑上的平凡通过：没有 required 项，就没有"有项没结论"这件事。
    // "没有验收清单"这种任务不从这里拿结论，而是由 audit.ts 的无清单分支
    // 明写一条人工待判项，再由 auditVerdict 判成 needs_review。
    expect(auditVerdict([])).toBe("pass");
    expect(checklistPassed([])).toBe(true);
  });

  it("非 required 的待判条目不阻塞结论", () => {
    const results = evaluateAcceptance("有内容。", [
      { type: "min_words", value: 1, required: true },
      { type: "manual", note: "可选复核", required: false },
    ]);
    expect(auditVerdict(results)).toBe("pass");
  });
});
