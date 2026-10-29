import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MEMORY_GOVERNANCE_LINES,
  MEMORY_HEADER_BADGES,
  conflictCellDetail,
  conflictStatHint,
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

/**
 * 冲突计数原来写着「待解决矛盾」（记忆页）与「待你裁定」（内阁页）。两者都
 * 在暗示一个不存在的动作：冲突行写入时就已 validTo = now，只落在「历史版本」
 * 栏，生效的那条没有被覆盖，而产品里唯一的写入面是删除。
 */
describe("conflict counters", () => {
  it("points at the tab that actually lists a conflicting row", () => {
    expect(conflictStatHint(2)).toContain("历史版本");
    expect(conflictCellDetail(2)).toContain("2 条自相矛盾");
    expect(conflictStatHint(2)).not.toContain("待解决");
    expect(conflictCellDetail(2)).not.toContain("待你裁定");
  });

  it("says there is nothing to resolve when the count is zero", () => {
    expect(conflictStatHint(0)).toBe("没有互相冲突的事实");
    expect(conflictCellDetail(0)).toBe("没有互相冲突的事实");
  });

  it("never prints a broken count", () => {
    expect(conflictCellDetail(Number.NaN)).toBe("没有互相冲突的事实");
    expect(conflictCellDetail(-1)).toBe("没有互相冲突的事实");
  });
});

/**
 * 页面结构的契约测试。
 *
 * 记忆页的列表和右侧两张卡片住在同一个两列网格里（lg:grid-cols-[1.7fr_1fr]）。
 * 分页条曾经被放在网格这一层，于是它成了第三个直接子元素：右列第一行被它占掉，
 * 两张卡片（记忆治理 / 三种记忆）被挤到列表下面去，分页条自己浮在右上方。
 * 这不是文案问题，所以只读源码就能验证：这个网格只能有两个直接子 div。
 */
describe("memory page layout", () => {
  const PAGE = join(process.cwd(), "src/app/memory/page.tsx");

  /** Direct `<div>` children of the element whose opening tag contains `marker`. */
  function divChildren(source: string, marker: string): string[] {
    const at = source.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const open = source.lastIndexOf("<div", at);
    let i = source.indexOf(">", open) + 1;
    let depth = 1;
    let childStart = -1;
    const children: string[] = [];
    while (i < source.length && depth > 0) {
      const nextOpen = source.indexOf("<div", i);
      const nextClose = source.indexOf("</div>", i);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        if (depth === 1) childStart = nextOpen;
        depth += 1;
        i = nextOpen + 4;
      } else {
        depth -= 1;
        if (depth === 1 && childStart !== -1) {
          children.push(source.slice(childStart, nextClose + "</div>".length));
          childStart = -1;
        }
        i = nextClose + "</div>".length;
      }
    }
    return children;
  }

  it("keeps the pager inside the list column, not in the grid", () => {
    const source = readFileSync(PAGE, "utf8");
    const children = divChildren(
      source,
      'className="grid gap-5 lg:grid-cols-[1.7fr_1fr]"',
    );
    expect(children).toHaveLength(2);
    expect(children[0]).toContain("条 / 共");
    expect(children[1]).toContain("space-y-5");
  });
});
