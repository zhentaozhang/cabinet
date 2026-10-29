import { describe, expect, it } from "vitest";

import { RECALL_CELL_HINT, recallAverageHint } from "@/lib/presentation/recall-view";

/**
 * 回忆正确率来自打卡里的自评，不是复测判分——两处旧文案都说成了「复测」，而同一屏上
 * 「复测通过率」是另一个指标（审计行的结论）。这几条断言就是那个区分。
 */
describe("recall copy", () => {
  it("says the empty case is a missing self-rating, not a missing retest", () => {
    const hint = recallAverageHint(null);
    expect(hint).toContain("打卡");
    expect(hint).toContain("没有填过回忆正确率");
    expect(hint).not.toContain("复测样本");
  });

  it("credits the number to the check-in self-rating and separates the retest rate", () => {
    const hint = recallAverageHint(0.72);
    expect(hint).toContain("check-in");
    expect(hint).toContain("自评");
    expect(hint).toContain("复测通过率是另一格");
    expect(hint).not.toContain("来自本周检索式复测");
  });

  it("keeps the short Today hint off the Retest wording", () => {
    expect(RECALL_CELL_HINT).toContain("自评");
    expect(RECALL_CELL_HINT).not.toContain("Retest");
  });
});
