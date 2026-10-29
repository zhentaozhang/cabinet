import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const CN_COUNT = [
  "零",
  "一",
  "二",
  "三",
  "四",
  "五",
  "六",
  "七",
  "八",
  "九",
  "十",
];

/**
 * tick 的步骤清单只存在于代码里（src/server/jobs/maintenance.ts 的 `tickSteps`），
 * 文档里那张表是抄的一份。抄漏过一次：`releaseStaleHolds` 加进 `tickSteps` 之后，
 * `docs/run-durability.md` 还写着「八步」、表里也没有它——而它管的正是「进程崩在
 * 预扣与结算之间，那笔钱就永远占着」这件运维要能查到的事。这里按顺序逐项对账，
 * 让下一次加步骤先红。
 */
describe("the tick docs list every step the code runs", () => {
  const code = source("src/server/jobs/maintenance.ts");
  const doc = source("docs/run-durability.md");
  const review = source("docs/backend-chain-review.md");

  const start = code.indexOf("export function tickSteps");
  const block = code.slice(start, code.indexOf("];", start));
  const names = [...block.matchAll(/name: "([A-Za-z]+)",/g)].map((m) => m[1]);

  it("reads a non-empty step list out of the code", () => {
    expect(names.length).toBeGreaterThan(5);
    expect(names[0]).toBe("recoverStaleRuns");
  });

  it("keeps the run-durability table in code order", () => {
    const table = doc.slice(
      doc.indexOf("| 步骤 | 做什么 |"),
      doc.indexOf("三张表的 TTL"),
    );
    const rows = [...table.matchAll(/^\| `([A-Za-z]+)` \|/gm)].map((m) => m[1]);
    expect(rows).toEqual(names);
  });

  it("counts the steps the same way in prose and in the arrow chain", () => {
    const word = CN_COUNT[names.length];
    expect(doc).toContain(`一轮按顺序做${word}步`);
    expect(doc).toContain(`第二轮跑出来是${word}个 0`);
    expect(doc).toContain(`${word}步全失败`);
    // 只看 11.4 那一节：文件别处还单独提过 `recoverStaleRuns`。
    const section = review.slice(review.indexOf("### 11.4 现在的 tick"));
    const chain = section.match(/`(recoverStaleRuns[^`]*)`/)?.[1] ?? "";
    expect(chain.split(" → ").map((step) => step.trim())).toEqual(names);
    expect(review).toContain(`### 11.4 现在的 tick（${word}步）`);
  });
});
