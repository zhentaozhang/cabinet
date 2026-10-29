import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkinMemoryContent } from "@/lib/domain/checkin-memory";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("checkinMemoryContent", () => {
  it("joins every field that was filled in", () => {
    const content = checkinMemoryContent({
      studyMinutes: 42,
      recallScore: 0.75,
      errorTags: ["召回", "重排", "召回"],
      note: "  把相似度换成了余弦  ",
    });
    expect(content).toBe(
      "学习 42 分钟；回忆正确率 75%；薄弱点：召回、重排；把相似度换成了余弦",
    );
  });

  it("keeps a zero recall score, because zero is a score", () => {
    expect(checkinMemoryContent({ recallScore: 0 })).toBe("回忆正确率 0%");
  });

  it("is empty when the check-in says nothing", () => {
    // saveCheckin 只在正文非空时插记忆行，所以这条空打卡不该被说成「已写入记忆」。
    expect(
      checkinMemoryContent({
        studyMinutes: 0,
        recallScore: null,
        errorTags: [],
        note: "   ",
      }),
    ).toBe("");
  });
});

describe("the memory badge reads the same rule the writer reads", () => {
  it("both the writer and the Today page call checkinMemoryContent", () => {
    const writer = source("src/server/services/commands/checkins.ts");
    const page = source("src/app/page.tsx");
    expect(writer).toContain("checkinMemoryContent(");
    expect(page).toContain("checkinMemoryContent(");
    // 徽章不能再无条件印「已写入记忆」：空打卡要走另一句。
    expect(page).toContain("没有内容可写入记忆");
  });

  it("does not promise a memory write the form may not perform", () => {
    // 打卡表单下面原来无条件写「会写入记忆，供明天使用」，而四个字段都空着的
    // 打卡根本不会插记忆行。现在它用同一个函数先算正文，空着就换一句。
    const form = source("src/components/actions/task-actions.tsx");
    expect(form).toContain("checkinMemoryContent(");
    expect(form).toContain("memoryPreview");
    expect(form).toContain("没有内容可写入记忆");
    // 那句话必须挂在 memoryPreview 的三元里，而不是直接印在 span 里。
    const promise = form.indexOf('? "会写入记忆，供明天使用"');
    expect(promise).toBeGreaterThan(-1);
    expect(form.indexOf("{memoryPreview")).toBeLessThan(promise);
  });
});
