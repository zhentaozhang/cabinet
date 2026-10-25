import { describe, expect, it } from "vitest";

import type { AcceptanceItem } from "@/lib/db/schema";
import {
  ACCEPTANCE_CONTRACT_VERSION,
  exportAcceptanceContract,
  renderAcceptanceContract,
} from "@/lib/domain/acceptance-export";

const checklist: AcceptanceItem[] = [
  { type: "section", value: "结论", required: true },
  { type: "min_words", value: 800, required: true },
  { type: "min_sources", value: 3, required: true },
  { type: "min_evidence", value: 2, required: true },
  { type: "contains", value: "风险", required: true },
  { type: "claims_table", value: 4, required: false },
  { type: "manual", note: "选题是否有价值", required: true },
];

function exported(itemList: AcceptanceItem[] = checklist) {
  return exportAcceptanceContract({
    taskId: "tsk_1",
    title: "写一份竞品调研",
    criteria: "要有结论、要引用来源",
    checklist: itemList,
  });
}

describe("exportAcceptanceContract", () => {
  it("covers all seven acceptance types", () => {
    const contract = exported();
    expect(contract.checks.map((check) => check.type)).toEqual([
      "section",
      "min_words",
      "min_sources",
      "min_evidence",
      "contains",
      "claims_table",
      "manual",
    ]);
    for (const check of contract.checks) {
      expect(check.statement.length).toBeGreaterThan(0);
    }
  });

  it("turns each type into its own machine spec", () => {
    const specs = Object.fromEntries(
      exported().checks.map((check) => [check.type, check.spec]),
    );
    expect(specs.section).toEqual({ section: "结论" });
    expect(specs.min_words).toEqual({ minWords: 800 });
    expect(specs.min_sources).toEqual({ minSources: 3 });
    expect(specs.min_evidence).toEqual({ minEvidence: 2, citation: "[cite:evd_…]" });
    expect(specs.contains).toEqual({ contains: "风险" });
    expect(specs.claims_table).toEqual({ claimsTableRows: 4 });
    expect(specs.manual).toBeNull();
  });

  it("marks the manual item as undetermined and keeps its note", () => {
    const manual = exported().checks[6];
    expect(manual.undetermined).toBe(true);
    expect(manual.statement).toContain("选题是否有价值");
    expect(manual.required).toBe(true);
    // The schema uses `note` for manual items; nothing may read `value` here.
    expect(manual.spec).toBeNull();
  });

  it("exports an undetermined line instead of an empty checklist", () => {
    const contract = exported([]);
    expect(contract.checks).toHaveLength(1);
    expect(contract.checks[0].type).toBe("manual");
    expect(contract.checks[0].undetermined).toBe(true);
    expect(contract.checks[0].statement).toContain("本任务没有验收清单");
  });

  it("produces identical bytes on two exports of the same task", () => {
    expect(JSON.stringify(exported())).toBe(JSON.stringify(exported()));
  });

  it("carries the contract version and the prose criteria verbatim", () => {
    const contract = exported();
    expect(contract.version).toBe(ACCEPTANCE_CONTRACT_VERSION);
    expect(contract.criteria).toBe("要有结论、要引用来源");
  });

  it("numbers checks positionally so ids survive a diff", () => {
    expect(exported().checks.map((check) => check.id)).toEqual([
      "0-section",
      "1-min_words",
      "2-min_sources",
      "3-min_evidence",
      "4-contains",
      "5-claims_table",
      "6-manual",
    ]);
  });
});

describe("renderAcceptanceContract", () => {
  it("labels undetermined lines in the rendered document", () => {
    const markdown = renderAcceptanceContract(exported());
    expect(markdown).toContain("# 验收契约：写一份竞品调研");
    expect(markdown).toContain("需人工判定");
    expect(markdown).toContain("1 项需要人工判定");
    expect(markdown).toContain("必须包含小节 «结论»");
  });

  it("is byte-identical across renders", () => {
    expect(renderAcceptanceContract(exported())).toBe(
      renderAcceptanceContract(exported()),
    );
  });
});
