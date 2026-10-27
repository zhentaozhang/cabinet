import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  README_FACT_NAMES,
  checkFacts,
  collectFacts,
  countRoutes,
  extractFactBlocks,
  renderFact,
  rewriteFacts,
  type Fact,
} from "../../scripts/doc-facts";

/**
 * README 里的数字过去是手写的，于是每个数字都只在那一天是对的：
 * "47 个 route" 在 48 个 route 时并没有报错，只是安静地撒谎。
 *
 * 这里测两件事，缺一不可：
 *  1. 纯函数能识别"块缺失 / 数字不符 / 正常"，否则 --check 没有可信度；
 *  2. 真实仓库扫出来的数字和 README 现有生成块一致，否则 --check 在 CI 里就是红的。
 */

const README = readFileSync(join(process.cwd(), "README.md"), "utf8");

const routes: Fact = {
  name: "routes",
  value: 48,
  command: "find src/app -name route.ts | wc -l",
};

const tables: Fact = {
  name: "tables",
  value: 40,
  command: "grep -ro 'pgTable(' src/lib/db/schema | wc -l",
};

function block(name: string, value: string): string {
  return `<!-- doc-facts:${name} -->${value}<!-- /doc-facts:${name} -->`;
}

describe("extractFactBlocks", () => {
  test("读出成对标记里的值，块外文本不进入值", () => {
    const blocks = extractFactBlocks(`当前 ${block("routes", "48")} 个，块外还有字。`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ name: "routes", value: "48", closed: true });
  });

  test("一个块可以跨行，值两端空白被裁掉", () => {
    const blocks = extractFactBlocks("<!-- doc-facts:tables -->\n  40  \n<!-- /doc-facts:tables -->");
    expect(blocks[0]).toMatchObject({ name: "tables", value: "40" });
  });

  test("缺闭合标记时 closed=false，而不是静默当成空块", () => {
    const blocks = extractFactBlocks("<!-- doc-facts:routes -->48");
    expect(blocks[0]).toMatchObject({ name: "routes", closed: false });
  });

  test("不同名字的块互不干扰", () => {
    const blocks = extractFactBlocks(`${block("routes", "48")} ${block("tables", "40")}`);
    expect(blocks.map((b) => [b.name, b.value])).toEqual([
      ["routes", "48"],
      ["tables", "40"],
    ]);
  });
});

describe("renderFact", () => {
  test("渲染出成对标记，且能被 extractFactBlocks 读回同一个值", () => {
    const rendered = renderFact(routes);
    expect(rendered).toBe(block("routes", "48"));
    expect(extractFactBlocks(rendered)[0]).toMatchObject({ name: "routes", value: "48" });
  });
});

describe("checkFacts", () => {
  test("数字一致时通过", () => {
    const result = checkFacts(`当前 ${block("routes", "48")} 个`, [routes]);
    expect(result.ok).toBe(true);
    expect(result.drift).toEqual([]);
  });

  test("数字不符时给出 expected / actual，并带上复现命令", () => {
    const result = checkFacts(`当前 ${block("routes", "47")} 个`, [routes]);
    expect(result.ok).toBe(false);
    expect(result.drift).toEqual([
      {
        name: "routes",
        kind: "mismatch",
        expected: "48",
        actual: "47",
        command: routes.command,
      },
    ]);
  });

  test("README 里根本没有这个块时 actual 为 null（缺失不等于通过）", () => {
    const result = checkFacts("一篇没有任何标记的文档", [tables]);
    expect(result.ok).toBe(false);
    expect(result.drift).toEqual([
      { name: "tables", kind: "missing", expected: "40", actual: null, command: tables.command },
    ]);
  });

  test("块没闭合时算 drift，不能当成已对齐", () => {
    const result = checkFacts("<!-- doc-facts:routes -->48", [routes]);
    expect(result.ok).toBe(false);
    expect(result.drift[0]).toMatchObject({ name: "routes", kind: "unclosed" });
  });

  test("多个数字里只报不对的那一个", () => {
    const markdown = `${block("routes", "48")} ${block("tables", "35")}`;
    const result = checkFacts(markdown, [routes, tables]);
    expect(result.drift.map((d) => d.name)).toEqual(["tables"]);
  });
});

describe("rewriteFacts", () => {
  test("只改块里的数字，块外文本原样保留", () => {
    const before = `架构里写着 ${block("routes", "47")} 个 route，这句话不该被动。`;
    const after = rewriteFacts(before, [routes]);
    expect(after).toBe(`架构里写着 ${block("routes", "48")} 个 route，这句话不该被动。`);
  });

  test("写两次结果相同（幂等），且写完之后 check 通过", () => {
    const once = rewriteFacts(`x ${block("routes", "1")} y`, [routes]);
    expect(rewriteFacts(once, [routes])).toBe(once);
    expect(checkFacts(once, [routes]).ok).toBe(true);
  });

  test("文档里缺这个块时原样返回，不凭空插入一块", () => {
    const before = "没有标记的文档";
    expect(rewriteFacts(before, [routes])).toBe(before);
  });
});

describe("真实仓库", () => {
  test("README 的 routes 块与扫描结果一致", () => {
    const scanned = countRoutes(process.cwd());
    const blocks = extractFactBlocks(README);
    const routesBlock = blocks.find((b) => b.name === "routes");
    expect(routesBlock, "README 里缺少 doc-facts:routes 块").toBeDefined();
    expect(Number(routesBlock?.value)).toBe(scanned);
  });

  test("README 里每个生成块都与扫描一致（等价于 --check 通过）", () => {
    const facts = collectFacts(process.cwd()).filter((fact) =>
      (README_FACT_NAMES as readonly string[]).includes(fact.name),
    );
    expect(facts.length).toBeGreaterThan(0);
    expect(checkFacts(README, facts)).toEqual({ ok: true, drift: [] });
  });

  test("README 页面表里同一路径只有一行（Settings 曾重复两行）", () => {
    const section = README.slice(README.indexOf("## 页面"), README.indexOf("## 快速开始"));
    const paths = [...section.matchAll(/^\|\s*[^|]+\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path, index) => paths.indexOf(path) !== index)).toEqual([]);
  });
});
