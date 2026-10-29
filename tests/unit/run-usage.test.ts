import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runCostLabel,
  runTokensLabel,
  stepTraceLabel,
} from "@/lib/presentation/run-usage";

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

describe("stepTraceLabel", () => {
  it("says no model was called instead of printing a zero that reads as usage", () => {
    expect(stepTraceLabel({ latencyMs: 30, tokensIn: 0, tokensOut: 0 })).toBe(
      "30ms · 未调用模型",
    );
    expect(stepTraceLabel({ latencyMs: 0, tokensIn: 0, tokensOut: 0 })).not.toContain(" tok");
  });

  it("marks the step-level figures as an estimate, not a bill", () => {
    // audit.ts 与 apprentice.ts 的确定性步骤写的是 80/40、200/0 这类固定
    // 常数，run.ts 的 context/plan/submit 也是估算；它们不是供应商回报的
    // 用量，而运行横幅上印的才是实测值（或「用量未知」）。
    expect(stepTraceLabel({ latencyMs: 100, tokensIn: 80, tokensOut: 40 })).toBe(
      "100ms · 约 120 tok",
    );
    expect(stepTraceLabel({ latencyMs: 2400, tokensIn: 111, tokensOut: 222 })).toContain(
      "约 333 tok",
    );
  });

  it("never prints NaN for a row with missing numbers", () => {
    const label = stepTraceLabel({
      latencyMs: Number.NaN,
      tokensIn: Number.NaN,
      tokensOut: -5,
    });
    expect(label).toBe("0ms · 未调用模型");
    expect(label).not.toContain("NaN");
  });
});

describe("the task page does not present trace estimates as provider usage", () => {
  it("renders every step figure through stepTraceLabel", () => {
    const page = readFileSync(
      join(process.cwd(), "src/app/tasks/[id]/page.tsx"),
      "utf8",
    );
    expect(page).toContain("stepTraceLabel(step)");
    expect(page).toContain("STEP_TRACE_TITLE");
    // 原来这里直接拼 step.tokensIn + step.tokensOut，把估算值印成了实测。
    expect(page).not.toMatch(/step\.tokensIn\s*\+\s*step\.tokensOut/);
  });
});
