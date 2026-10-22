import { describe, expect, it } from "vitest";

import { evaluateAcceptance } from "@/lib/domain/acceptance";
import type { AcceptanceItem } from "@/lib/db/schema";

const item: AcceptanceItem = { type: "min_evidence", value: 2, required: true };

function check(content: string, ids: string[] | null) {
  const context =
    ids === null
      ? { evidenceCount: 2 }
      : { evidenceCount: ids.length, evidenceIds: new Set(ids) };
  return evaluateAcceptance(content, [item], context)[0];
}

describe("min_evidence counts retrieved rows, not prose", () => {
  it("passes only when citations resolve to persisted evidence", () => {
    const result = check("结论 A [cite:evd_a]，结论 B [cite:evd_b]。", [
      "evd_a",
      "evd_b",
    ]);
    expect(result.passed).toBe(true);
    expect(result.reason).toContain("2 条已落库证据");
  });

  it("fails when the draft cites fewer sources than required", () => {
    const result = check("结论 A [cite:evd_a]。", ["evd_a", "evd_b"]);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("要求至少 2");
  });

  it("fails when a citation points at evidence that does not exist", () => {
    const result = check(
      "[cite:evd_a] [cite:evd_b] [cite:evd_ghost]",
      ["evd_a", "evd_b"],
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("指向不存在的证据");
  });

  it("ignores a repeated citation of the same row", () => {
    const result = check("[cite:evd_a] [cite:evd_a] [cite:evd_a]", [
      "evd_a",
      "evd_b",
    ]);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("1 条已落库证据");
  });

  it("does not count bare URLs as evidence", () => {
    const result = check(
      "参考 https://example.com/a 与 https://example.com/b。",
      ["evd_a", "evd_b"],
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("0 条已落库证据");
  });

  it("keeps the URL-counting behaviour for min_sources, and says so", () => {
    const [sources] = evaluateAcceptance(
      "见 https://example.com/a 和 https://example.com/b",
      [{ type: "min_sources", value: 2, required: true }],
    );
    expect(sources.passed).toBe(true);
    expect(sources.reason).toContain("仅计数，未验证可达性");
  });
});
