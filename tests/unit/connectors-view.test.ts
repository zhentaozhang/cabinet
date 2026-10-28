import { describe, expect, it } from "vitest";

import { modelBillingHint } from "@/lib/presentation/connectors-view";

// 连接器页原来写「用量与费用记在每周预算台账里」，而判卷那次调用从不预留也从不
// 结算：用户会以为调低周上限就能挡住判卷开销。
describe("modelBillingHint", () => {
  it("说清哪些调用的费用真的进了周预算", () => {
    const hint = modelBillingHint("OpenAI");

    expect(hint).toContain("OpenAI");
    expect(hint).toContain("生成产物与模型选工具");
    expect(hint).toContain("每周预算台账");
  });

  it("不承诺判卷的费用也在预算台账里", () => {
    const hint = modelBillingHint("OpenAI");

    expect(hint).not.toContain("用量与费用记在每周预算台账里");
    expect(hint).toContain("判卷");
    expect(hint).toContain("只记在那条审计运行上");
    expect(hint).toContain("不进周预算");
  });
});
