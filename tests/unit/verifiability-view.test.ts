import { describe, expect, it } from "vitest";

import {
  DIGEST_PROOF_NOTE,
  EXPORT_CONTENT_NOTE,
  OFFLINE_CHECK_NOTE,
} from "@/lib/presentation/verifiability-view";

/**
 * 这三句是页面给外部的承诺，所以测试断言的是「说了什么、没说什么」，不是渲染：
 * 说多了比说少了更糟——对方会照着这句话去核，然后发现核不了。
 */
describe("verifiability copy", () => {
  it("does not claim the exports hold nothing but hashes", () => {
    expect(EXPORT_CONTENT_NOTE).not.toContain("只包含哈希");
    // 真实情况：验收判定带条目原文，契约整份是文字。
    expect(EXPORT_CONTENT_NOTE).toContain("验收逐条判定带的是清单条目原文");
    expect(EXPORT_CONTENT_NOTE).toContain("验收契约整份都是文字");
    // 提示词确实只以哈希出现，这一条要保留，否则改过头就成了另一种误导。
    expect(EXPORT_CONTENT_NOTE).toContain("不含你的提示词原文");
    expect(EXPORT_CONTENT_NOTE).toContain("提示词只以哈希出现");
  });

  it("says what offline verification recomputes, not more", () => {
    expect(OFFLINE_CHECK_NOTE).toContain("自洽");
    expect(OFFLINE_CHECK_NOTE).toContain("步骤与产物的原文不在文件里");
    expect(OFFLINE_CHECK_NOTE).toContain("不是内容本身");
  });

  it("does not promise that a digest proves who produced the file", () => {
    expect(DIGEST_PROOF_NOTE).not.toContain("就能判断它有没有被改过");
    expect(DIGEST_PROOF_NOTE).toContain("把 digest 一起重算");
    expect(DIGEST_PROOF_NOTE).toContain("验不出来");
    // 唯一的对外锚点是审计链，必须点名它需要链路数据。
    expect(DIGEST_PROOF_NOTE).toContain("链路数据");
    expect(DIGEST_PROOF_NOTE).toContain("不是这份文件出自本系统");
  });
});
