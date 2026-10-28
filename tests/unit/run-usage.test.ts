import { describe, expect, it } from "vitest";
import { runCostLabel, runTokensLabel } from "@/lib/presentation/run-usage";

describe("runTokensLabel", () => {
  it("says the usage is unknown instead of printing a measured zero", () => {
    expect(runTokensLabel({ tokensIn: null, tokensOut: null })).toBe("用量未知");
    expect(runTokensLabel({ tokensIn: 120, tokensOut: null })).toBe("用量未知");
  });

  it("adds the two halves when the provider reported them", () => {
    expect(runTokensLabel({ tokensIn: 120, tokensOut: 34 })).toBe("154 tokens");
  });
});

describe("runCostLabel", () => {
  it("does not turn an unreported provider call into zero money", () => {
    // llm.ts 对超时/供应商报错/空回复一律记 costSource "unknown"：请求可能真
    // 的到了对方那边，只是没报用量。行里再印 ¥0.00 就是把未知说成零。
    expect(runCostLabel({ costCents: 0, costSource: "unknown" })).toBe("费用未知");
    expect(runCostLabel({ costCents: 0, costSource: "unknown" })).not.toBe("¥0.00");
  });

  it("still prints a real zero for a run that never called a provider", () => {
    // demo / 规则稿 / 模型未配置：确实没花钱，0 是真值。
    expect(runCostLabel({ costCents: 0, costSource: null })).toBe("¥0.00");
  });

  it("prints the cost the provider reported", () => {
    expect(runCostLabel({ costCents: 12, costSource: "actual" })).toBe("¥0.12");
  });
});
