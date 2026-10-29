import { describe, expect, it } from "vitest";

import { modelBillingHint, modelMissingHint } from "@/lib/presentation/connectors-view";

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

// 设置页原来在模型未配置时写「任务会停在生成草稿前」：演示模式下会用模板稿照常
// 提交，非演示模式下执行直接失败——两种情形都不是「停在草稿前」。
describe("modelMissingHint", () => {
  it("演示模式说清会用模板稿走完流程", () => {
    const hint = modelMissingHint(true, "OPENAI_API_KEY");

    expect(hint).toContain("演示模式");
    expect(hint).toContain("模板稿");
    expect(hint).toContain("OPENAI_API_KEY");
    expect(hint).not.toContain("停在生成草稿前");
  });

  it("非演示模式说清执行会失败，而不是停在草稿前", () => {
    const hint = modelMissingHint(false, "OPENAI_API_KEY");

    expect(hint).toContain("执行会直接失败");
    expect(hint).toContain("执行失败");
    expect(hint).not.toContain("停在生成草稿前");
  });
});
