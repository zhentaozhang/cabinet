import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * README 里的数字由代码算出来。
 *
 * 手写数字的问题不是"写错了一次"，而是它只在写下的那一天正确：route 从 47 变成 48
 * 时没有任何东西会失败，README 只是安静地开始撒谎。README 里已经出现过三处这种数字
 * （route 数、表数、测试数），还写着一句"不要照抄"——一句要读者自己核对的说明书，
 * 等于承认这些数字不可信。
 *
 * 所以这里把每个数字变成一个可扫描的事实，并在 README 里用成对标记圈住：
 *
 *   <!-- doc-facts:routes -->48<!-- /doc-facts:routes -->
 *
 *   tsx scripts/doc-facts.ts --write   # 重写块内数字（pnpm doc:facts）
 *   tsx scripts/doc-facts.ts --check   # 只比对，不一致打印 diff 并 exit 1（pnpm verify 里跑）
 *
 * 每个数字单独一块而不是一整段：只改 route 数时不该让表数和测试数的行也进 diff，
 * review 时才看得出"这次真的只是 route 变多了"。
 *
 * 数字全部来自扫描，没有任何手写常量——一个可以被手改的"生成块"和手写没有区别。
 */

/** README 目前用到的数字。扫描得到的其它事实也在 collectFacts 里，只是没进 README。 */
export const README_FACT_NAMES = [
  "routes",
  "tables",
  "testFiles",
  "testCases",
] as const;

export type FactName =
  | "routes"
  | "pages"
  | "tables"
  | "testFiles"
  | "testCases"
  | "srcLines";

export type Fact = {
  name: FactName;
  value: number;
  /** 复现这条数字的命令：漂移报错里要能直接跑一遍，而不是让人猜数字怎么来的。 */
  command: string;
};

export type FactBlock = {
  name: string;
  value: string;
  /** 缺闭合标记的块不算"已对齐"：它可能吞掉了后面半篇文档。 */
  closed: boolean;
  /** 起始标记在 markdown 里的下标（含标记本身）。 */
  start: number;
  /** 结束标记之后的下标。 */
  end: number;
};

export type FactDrift = {
  name: string;
  kind: "missing" | "mismatch" | "unclosed";
  expected: string;
  actual: string | null;
  command: string;
};

const OPEN_MARKER = /<!--\s*doc-facts:([A-Za-z0-9_-]+)\s*-->/g;

function closeMarker(name: string): RegExp {
  return new RegExp("<!--\\s*/doc-facts:" + name + "\\s*-->", "g");
}

/**
 * 读出所有生成块。
 *
 * 缺失的块不出现在返回值里（交回给 checkFacts 判定"缺失"），但缺闭合标记的块要出现：
 * 一个没关上的标记会把块后面全部内容当成数字，静默忽略等于让 check 永远绿。
 */
export function extractFactBlocks(markdown: string): FactBlock[] {
  const blocks: FactBlock[] = [];
  const open = new RegExp(OPEN_MARKER.source, "g");
  let match: RegExpExecArray | null;

  while ((match = open.exec(markdown)) !== null) {
    const name = match[1];
    const valueStart = match.index + match[0].length;
    const closer = closeMarker(name);
    closer.lastIndex = valueStart;
    const closed = closer.exec(markdown);

    if (!closed) {
      blocks.push({
        name,
        value: markdown.slice(valueStart).trim(),
        closed: false,
        start: match.index,
        end: markdown.length,
      });
      // 没有闭合标记，后面的内容都已经被算进这一块了，没有第二块可读。
      break;
    }

    blocks.push({
      name,
      value: markdown.slice(valueStart, closed.index).trim(),
      closed: true,
      start: match.index,
      end: closed.index + closed[0].length,
    });
    open.lastIndex = closed.index + closed[0].length;
  }

  return blocks;
}

function renderBlock(name: string, value: string): string {
  // 标记和数字之间不留空格：README 里是行内使用，多一个空格就会渲染出一个空格。
  return "<!-- doc-facts:" + name + " -->" + value + "<!-- /doc-facts:" + name + " -->";
}

export function renderFact(fact: Fact): string {
  return renderBlock(fact.name, String(fact.value));
}

/**
 * 比对 README 与扫描结果。
 *
 * 三种都有问题，但只有两种是"数字不对"：缺块意味着这段话根本没有被生成，
 * 所以它和数字不符一样必须失败——不然把标记删掉就成了绕过检查最省事的方式。
 */
export function checkFacts(
  markdown: string,
  facts: Fact[],
): { ok: boolean; drift: FactDrift[] } {
  const blocks = extractFactBlocks(markdown);
  const drift: FactDrift[] = [];

  for (const fact of facts) {
    const expected = String(fact.value);
    const matching = blocks.filter((block) => block.name === fact.name);

    if (matching.length === 0) {
      drift.push({
        name: fact.name,
        kind: "missing",
        expected,
        actual: null,
        command: fact.command,
      });
      continue;
    }

    for (const block of matching) {
      if (!block.closed) {
        drift.push({
          name: fact.name,
          kind: "unclosed",
          expected,
          actual: block.value,
          command: fact.command,
        });
      } else if (block.value !== expected) {
        drift.push({
          name: fact.name,
          kind: "mismatch",
          expected,
          actual: block.value,
          command: fact.command,
        });
      }
    }
  }

  return { ok: drift.length === 0, drift };
}

/**
 * 重写块内数字。
 *
 * 只碰已闭合的块，块外文本逐字保留：这个函数可能的调用者是 `--write`，
 * 而 `--write` 不该有"顺便重排了 README"的能力。缺块也不插入——插入位置是编辑决定，
 * 不是扫描能回答的问题，插错了比不插更难发现。
 */
export function rewriteFacts(markdown: string, facts: Fact[]): string {
  // 键显式写成 string：块名来自 markdown，可能是任何名字，不该被收窄成 FactName。
  const values = new Map<string, string>(
    facts.map((fact): [string, string] => [fact.name, String(fact.value)]),
  );
  const rewritable = extractFactBlocks(markdown)
    .filter((block) => block.closed && values.has(block.name))
    .sort((a, b) => b.start - a.start);

  let out = markdown;
  for (const block of rewritable) {
    const value = values.get(block.name) as string;
    out = out.slice(0, block.start) + renderBlock(block.name, value) + out.slice(block.end);
  }
  return out;
}

function walkFiles(dir: string, accept: (name: string) => boolean): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // 目录不存在就是 0 个，而不是抛错：一个删掉了 tests/ 的仓库应该报"少了 133 个测试"，
    // 不是在读数字时崩掉。
    return [];
  }

  const found: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(path, accept));
    else if (entry.isFile() && accept(entry.name)) found.push(path);
  }
  return found;
}

function countIn(file: string, pattern: RegExp): number {
  return [...readFileSync(file, "utf8").matchAll(pattern)].length;
}

export function countRoutes(rootDir: string): number {
  return walkFiles(join(rootDir, "src", "app"), (name) => name === "route.ts").length;
}

export function countPages(rootDir: string): number {
  return walkFiles(join(rootDir, "src", "app"), (name) => name === "page.tsx").length;
}

export function schemaFiles(rootDir: string): string[] {
  return walkFiles(join(rootDir, "src", "lib", "db", "schema"), (name) => name.endsWith(".ts"));
}

/**
 * 表的数量 = `pgTable(` 调用点。
 *
 * 不数 migration 里的 `create table`：那里面还有索引、约束和已经被删掉的表，
 * 而 README 那句话说的是"现在有哪些表"，答案在 schema 定义里。
 */
export function countTables(rootDir: string): number {
  return schemaFiles(rootDir).reduce(
    (total, file) => total + countIn(file, /pgTable\(/g),
    0,
  );
}

export function testFiles(rootDir: string): string[] {
  return walkFiles(join(rootDir, "tests"), (name) => name.endsWith(".test.ts"));
}

export function countTestFiles(rootDir: string): number {
  return testFiles(rootDir).length;
}

/**
 * 用例数 = 源码里的 `it(` / `test(` 调用点。
 *
 * 不跑 vitest 拿 "N passed"：那需要数据库、要几十秒，而 verify 里已经有一步在跑它了；
 * 这里要的是"README 里的数字能不能被一条命令复现"。代价是 `it.each` 只算一条，
 * 而运行时每个数据集各算一条，所以这个数必然小于 vitest 报的 passed——README 里写明了这点，
 * 不把两个口径混成一个数字。
 */
export function countTestCases(rootDir: string): number {
  return testFiles(rootDir).reduce(
    (total, file) => total + countIn(file, /^[ \t]*(?:it|test)(?:\.[A-Za-z]+)*\(/gm),
    0,
  );
}

/** src 的 TS/TSX 行数；等于 `find src ... | xargs cat | wc -l`（数换行符）。 */
export function countSrcLines(rootDir: string): number {
  const files = walkFiles(join(rootDir, "src"), (name) => /\.(ts|tsx)$/.test(name));
  return files.reduce((total, file) => {
    const source = readFileSync(file, "utf8");
    return total + (source.match(/\n/g)?.length ?? 0);
  }, 0);
}

export function collectFacts(rootDir: string): Fact[] {
  return [
    {
      name: "routes",
      value: countRoutes(rootDir),
      command: "find src/app -name route.ts | wc -l",
    },
    {
      name: "pages",
      value: countPages(rootDir),
      command: "find src/app -name page.tsx | wc -l",
    },
    {
      name: "tables",
      value: countTables(rootDir),
      command: "grep -ro 'pgTable(' src/lib/db/schema | wc -l",
    },
    {
      name: "testFiles",
      value: countTestFiles(rootDir),
      command: "find tests -name '*.test.ts' | wc -l",
    },
    {
      name: "testCases",
      value: countTestCases(rootDir),
      command: "grep -rhoE '^[[:space:]]*(it|test)(\\.[A-Za-z]+)*\\(' tests --include='*.test.ts' | wc -l",
    },
    {
      name: "srcLines",
      value: countSrcLines(rootDir),
      command: "find src -type f \\( -name '*.ts' -o -name '*.tsx' \\) -exec cat {} + | wc -l",
    },
  ];
}

function readmeFacts(rootDir: string): Fact[] {
  const names = new Set<string>(README_FACT_NAMES);
  return collectFacts(rootDir).filter((fact) => names.has(fact.name));
}

function usage(): never {
  console.error("usage: doc-facts [--check|--write] [--root <dir>]");
  process.exit(2);
}

function main(argv: string[]): number {
  const write = argv.includes("--write");
  const check = argv.includes("--check") || !write;
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag === -1 ? process.cwd() : resolve(argv[rootFlag + 1] ?? "");
  if (rootFlag !== -1 && !argv[rootFlag + 1]) usage();

  const unknown = argv.filter(
    (arg, index) => arg.startsWith("--") && !["--check", "--write", "--root"].includes(arg) && argv[index - 1] !== "--root",
  );
  if (unknown.length > 0) usage();

  const readmePath = join(root, "README.md");
  let markdown: string;
  try {
    markdown = readFileSync(readmePath, "utf8");
  } catch (error) {
    // 读不到 README 不是"没事"，是这一步没法判定——exit 2 和"数字漂移(1)"分开。
    console.error("doc-facts: 读不到 " + relative(root, readmePath) + ": " + (error as Error).message);
    return 2;
  }

  const facts = readmeFacts(root);

  if (write) {
    const next = rewriteFacts(markdown, facts);
    if (next === markdown) {
      console.log("doc-facts: README 已是最新（" + summary(facts) + "）");
      return 0;
    }
    writeFileSync(readmePath, next, "utf8");
    console.log("doc-facts: 已重写 README（" + summary(facts) + "）");
    for (const fact of facts) console.log("  " + fact.name + " = " + fact.value);
    return 0;
  }

  if (!check) usage();

  const result = checkFacts(markdown, facts);
  if (result.ok) {
    console.log("doc-facts: ok（" + summary(facts) + "）");
    return 0;
  }

  console.error(
    "doc-facts: README 的数字和扫描结果不一致（" + result.drift.length + " 处漂移）",
  );
  for (const item of result.drift) {
    const detail =
      item.kind === "missing"
        ? "README 里缺少 <!-- doc-facts:" + item.name + " --> 块"
        : item.kind === "unclosed"
          ? "<!-- doc-facts:" + item.name + " --> 没有闭合标记"
          : "README 里是 " + JSON.stringify(item.actual) + "，扫描结果是 " + item.expected;
    console.error("  " + item.name + ": " + detail);
    console.error("    复现: " + item.command);
    if (item.kind === "mismatch") {
      console.error("    - " + renderBlock(item.name, item.actual as string));
      console.error("    + " + renderBlock(item.name, item.expected));
    }
  }
  console.error("先跑 `pnpm doc:facts`（tsx scripts/doc-facts.ts --write）重写 README，再提交。");
  return 1;
}

function summary(facts: Fact[]): string {
  return facts.map((fact) => fact.name + "=" + fact.value).join(", ");
}

const entry = process.argv[1];
if (entry && pathToFileURL(resolve(entry)).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
