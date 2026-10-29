import { describe, expect, it } from "vitest";

import { notices } from "@/server/services/commands/notify";

/*
 * 冲突通知是这条链上唯一会主动找用户的一步，所以它说的每句话都得对应一处
 * 真实行为：writeMemoryFact 遇到不能覆盖的冲突时，旧行一个字段都不动（继续
 * 生效、继续被检索），新行写入即 validTo = now、status = "conflicted"，只落在
 * 「历史版本」栏（src/server/services/queries/memory.ts 的 viewFilter 按
 * isNotNull(validTo) 选它），而且整条链路里没有任何「二选一」的接口。
 */
describe("conflict notification", () => {
  const copy = notices.conflict({
    factKey: "bedtime",
    value: "23:30",
    previous: "22:30",
  });

  it("links to the tab where the conflicting row actually lives", () => {
    // 冲突行 validTo 非空，只在「历史版本」栏出现；链到 ?view=current 会打开
    // 一个看不到这条记录的页面。
    expect(copy.href).toBe("/memory?view=history");
    expect(copy.href).not.toContain("view=current");
  });

  it("says the live row was left alone instead of asking for a verdict", () => {
    expect(copy.body).toContain("仍在生效");
    expect(copy.body).toContain("不参与检索");
    expect(copy.body).not.toContain("需要你确认哪一条为准");
  });

  it("names the only action that changes anything: deleting the live row", () => {
    expect(copy.body).toContain("删掉");
    expect(copy.body).toContain("没有「二选一」的裁定按钮");
  });
});