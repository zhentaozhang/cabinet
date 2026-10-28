import { describe, expect, it } from "vitest";

import {
  MEMORY_GOVERNANCE_LINES,
  MEMORY_HEADER_BADGES,
} from "@/lib/presentation/memory-view";

/**
 * 这一栏每一句都是对运行时的承诺，所以测试问的是「能不能兑现」，不是
 * 「文案对不对」。为了验证它真的会红，先把它改回旧的坏文案跑一遍。
 */
describe("memory page promises", () => {
  it("never promises an edit path that does not exist", () => {
    // 记忆只有 DELETE /api/memories/[id]：没有 PATCH 路由，也没有编辑表单
    // （src/components/memory-actions.tsx 只渲染「删除」）。徽章写「可编辑」
    // 会让人去找一个找不到的按钮。
    const badges = MEMORY_HEADER_BADGES.join(" ");
    expect(badges).toContain("删除");
    expect(badges).not.toContain("编辑");
  });

  it("does not claim a confirmation gate for high-impact memories", () => {
    // 代码里没有按领域要求确认的闸门：Agent 写的 domain=health 记忆直接
    // active（seed 的 mem_evening 就是这样）。所谓「高影响」只是产品愿望，
    // 写在治理卡里就成了假承诺。
    const copy = MEMORY_GOVERNANCE_LINES.join(" ");
    expect(copy).not.toContain("必须由你确认");
    expect(copy).not.toContain("健康");
    expect(copy).not.toContain("财务");
  });

  it("describes the rules the command layer actually enforces", () => {
    const copy = MEMORY_GOVERNANCE_LINES.join(" ");
    // 写入面（checkins / facts / task-lesson / insights / council）都带来源事件。
    expect(copy).toContain("来源事件");
    // facts.ts 的 canSupersede：userId 权威或置信度达标才取代，否则另存冲突。
    expect(copy).toContain("待确认");
    expect(copy).toContain("冲突");
    // retrieval.ts：近因锚点 + 过期行由 SQL 过滤；置信度不参与排序。
    expect(copy).toContain("近因");
    expect(copy).toContain("过期");
    expect(copy).not.toContain("低置信");
  });
});
