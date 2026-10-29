import { describe, expect, it } from "vitest";

import { workspaceBudget } from "@/lib/domain/agent-budget";

/**
 * 工作区预算视图的口径：额度是按 Agent 分桶的，一周能花的是这些桶之和。
 * 之前反思洞察与内阁财务官都把「各 Agent 花费之和」除以单个 Agent 的上限，
 * 于是每个 Agent 都在自己额度内也读成「预算已用 133%」，报出来的剩余额度也没人
 * 能花——这两条断言就是那个错口径的反面。
 */
describe("workspaceBudget", () => {
  it("sums the per-Agent caps instead of reusing one Agent's ceiling", () => {
    const view = workspaceBudget([
      { limitCents: 60_000, settledCents: 40_000, unknownCents: 0 },
      { limitCents: 60_000, settledCents: 40_000, unknownCents: 0 },
    ]);
    expect(view.limitCents).toBe(120_000);
    expect(view.spentCents).toBe(80_000);
    // 两个 Agent 各自 67%，合起来也才 67% —— 不是 133%。
    expect(view.ratio).toBeCloseTo(2 / 3, 6);
    expect(view.tightest?.ratio).toBeCloseTo(2 / 3, 6);
  });

  it("reports the Agent that is closest to its own cap", () => {
    const view = workspaceBudget([
      { limitCents: 3_000, settledCents: 2_400, unknownCents: 0 },
      { limitCents: 60_000, settledCents: 30_000, unknownCents: 0 },
    ]);
    expect(view.tightest?.index).toBe(0);
    expect(view.tightest?.spentCents).toBe(2_400);
    expect(view.tightest?.limitCents).toBe(3_000);
    expect(view.tightest?.ratio).toBeCloseTo(0.8, 6);
  });

  it("counts an uncapped Agent's spend but not its capacity", () => {
    const view = workspaceBudget([
      { limitCents: 0, settledCents: 5_000, unknownCents: 0 },
      { limitCents: 10_000, settledCents: 1_000, unknownCents: 500 },
    ]);
    expect(view.spentCents).toBe(6_500);
    expect(view.limitCents).toBe(10_000);
    // 不设上限的 Agent 不可能「接近上限」，所以 tightest 只能是设了额度的那个。
    expect(view.tightest?.index).toBe(1);
    expect(view.ratio).toBeCloseTo(0.65, 6);
  });

  it("keeps an overrun visible and swallows non-finite numbers", () => {
    const overrun = workspaceBudget([
      { limitCents: 1_000, settledCents: 1_400, unknownCents: 0 },
    ]);
    expect(overrun.ratio).toBeCloseTo(1.4, 6);

    const broken = workspaceBudget([
      { limitCents: 1_000, settledCents: Number.NaN, unknownCents: -50 },
    ]);
    expect(broken.spentCents).toBe(0);
    expect(broken.ratio).toBe(0);
  });
});
