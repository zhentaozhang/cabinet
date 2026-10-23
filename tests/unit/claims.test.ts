import { describe, expect, it } from "vitest";
import { checkClaimsTable, parseClaimsTable, refsIn } from "@/lib/domain/claims";

const TABLE = [
  "## 主张—来源",
  "",
  "| 主张 | 引用 | 是否被原文支持 |",
  "| --- | --- | --- |",
  "| RAG 在生成前检索外部文档 | [cite:evd_a] |  |",
  "| 检索结果会进入提示词 | [cite:evd_b] |  |",
  "| 评测仍然困难 | [cite:evd_a] | 是 |",
].join("\n");

const ids = new Set(["evd_a", "evd_b"]);

describe("claims table parsing", () => {
  it("reads the model's table as written", () => {
    const table = parseClaimsTable(TABLE);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0].claim).toBe("RAG 在生成前检索外部文档");
    expect(table.rows[0].refs).toEqual(["evd_a"]);
    expect(table.rows[2].supported).toBe("是");
  });

  it("finds nothing when the draft has no table", () => {
    expect(parseClaimsTable("只有正文，没有表格。").rows).toHaveLength(0);
  });

  it("accepts a bare id and a marker for the same row without duplicating", () => {
    expect(refsIn("evd_a 与 [cite:evd_a]")).toEqual(["evd_a"]);
  });
});

describe("claims table check", () => {
  it("passes the shape when every row cites a persisted id", () => {
    const check = checkClaimsTable(TABLE, ids, 3);
    expect(check.ok).toBe(true);
    expect(check.dangling).toEqual([]);
  });

  it("fails when a row cites an id that was never stored", () => {
    const content = TABLE.replace("[cite:evd_b]", "[cite:evd_ghost]");
    const check = checkClaimsTable(content, ids, 3);
    expect(check.ok).toBe(false);
    expect(check.dangling).toEqual(["evd_ghost"]);
    expect(check.problems.join()).toContain("引用了不存在的证据");
  });

  it("fails when a row cites nothing", () => {
    const content = TABLE.replace("| [cite:evd_b] |", "|  |");
    const check = checkClaimsTable(content, ids, 3);
    expect(check.ok).toBe(false);
    expect(check.problems.join()).toContain("没有引用任何证据");
  });

  it("fails when there are fewer rows than the checklist demands", () => {
    const check = checkClaimsTable(TABLE, ids, 5);
    expect(check.ok).toBe(false);
    expect(check.problems.join()).toContain("要求至少 5 行");
  });

  it("does not pretend to resolve ids when the run has no evidence", () => {
    // A hand-written submission has no run, so there is nothing to resolve
    // against; the shape can still be checked.
    const check = checkClaimsTable(TABLE, undefined, 3);
    expect(check.ok).toBe(true);
    expect(check.dangling).toEqual([]);
  });
});
