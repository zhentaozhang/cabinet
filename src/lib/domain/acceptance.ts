import { checkClaimsTable } from "./claims";
import type {
  AcceptanceItem,
  AcceptanceResult,
} from "@/lib/db/schema";

function countWords(content: string): number {
  const han = (content.match(/[\p{Script=Han}]/gu) ?? []).length;
  const rest = content
    .replace(/[\p{Script=Han}]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return han + rest;
}

function countSources(content: string): number {
  return (content.match(/https?:\/\/[^\s)\]>]+/g) ?? []).length;
}

/** Citation marker a draft must use: `[cite:evd_xxx]`. */
export const CITE_PATTERN = /\[cite:(evd_[A-Za-z0-9_-]+)\]/g;

/**
 * Every evidence id the draft points at, in first-mention order. Shared with
 * the task page so "which source does this sentence rest on" is answered by
 * one rule, not two drifting copies.
 */
export function citedEvidenceIds(content: string): string[] {
  return Array.from(content.matchAll(CITE_PATTERN), (match) => match[1] as string);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Facts the evaluator cannot read out of the prose itself. `evidenceCount` is
 * the number of rows persisted for this run — never the number of URLs that
 * happen to appear in the text, which a model can hallucinate.
 */
export type AcceptanceContext = {
  evidenceCount?: number;
  /**
   * Ids persisted for this run. When present, `min_evidence` counts only
   * citations that resolve to a real row, so a fabricated `[cite:…]` fails
   * instead of inflating the score.
   */
  evidenceIds?: Set<string>;
  /**
   * False for a hand-submitted artifact: there is no run, so no retrieval
   * happened and an evidence rule cannot judge it — it becomes a manual item.
   */
  evidenceApplicable?: boolean;
};

/**
 * Deterministic checklist evaluator. It deliberately does not call a model:
 * the Auditor must be able to explain every pass/fail line.
 */
export function evaluateAcceptance(
  content: string,
  checklist: AcceptanceItem[],
  context: AcceptanceContext = {},
): AcceptanceResult[] {
  return checklist.map((item) => {
    if (item.type === "contains") {
      const passed = content.includes(item.value);
      return {
        item,
        passed,
        reason: passed
          ? `包含「${item.value}」`
          : `缺少「${item.value}」`,
      };
    }

    if (item.type === "min_words") {
      const count = countWords(content);
      return {
        item,
        passed: count >= item.value,
        reason: `字数 ${count}，要求至少 ${item.value}`,
      };
    }

    if (item.type === "min_sources") {
      const count = countSources(content);
      // Counting links says nothing about whether they exist, are reachable,
      // or support a claim. Say so, so nobody reads this line as verification.
      return {
        item,
        passed: count >= item.value,
        reason: `正文引用链接 ${count} 个（仅计数，未验证可达性），要求至少 ${item.value}`,
      };
    }

    if (item.type === "min_evidence") {
      if (context.evidenceApplicable === false) {
        return {
          item,
          passed: false,
          undetermined: true,
          reason: `人工提交的产物没有检索证据，此项需你人工复核（要求至少 ${item.value} 条）`,
        };
      }
      const known = context.evidenceIds;
      if (!known) {
        const count = context.evidenceCount ?? 0;
        const passed = count >= item.value;
        return {
          item,
          passed,
          reason: passed
            ? `已落库证据 ${count} 条，要求至少 ${item.value}`
            : `已落库证据 ${count} 条，少于要求的 ${item.value} 条（正文里的链接不算证据）`,
        };
      }
      const cited = citedEvidenceIds(content);
      const valid = Array.from(new Set(cited.filter((id) => known.has(id))));
      const dangling = cited.filter((id) => !known.has(id)).length;
      const enough = valid.length >= item.value;
      const passed = enough && dangling === 0;
      const detail = dangling > 0 ? `，另有 ${dangling} 处引用指向不存在的证据` : "";
      return {
        item,
        passed,
        reason: passed
          ? `引用了 ${valid.length} 条已落库证据，要求至少 ${item.value}`
          : `引用了 ${valid.length} 条已落库证据，要求至少 ${item.value}${detail}`,
      };
    }

    if (item.type === "claims_table") {
      // Format only: the table exists, every row cites a persisted id. Whether
      // a quote actually supports its claim is a human judgement, so a
      // well-formed table is 需人工复核, never 通过.
      const check = checkClaimsTable(content, context.evidenceIds, item.value);
      if (!check.ok) {
        return { item, passed: false, reason: `主张—来源表不合格：${check.problems.join("；")}` };
      }
      return {
        item,
        passed: false,
        undetermined: true,
        reason: `主张—来源表格式合格（${check.rows.length} 行，引用均可解析），每行是否被原文支持需你逐行核对`,
      };
    }

    if (item.type === "section") {
      const pattern = new RegExp(
        `^#{1,3}\\s*${escapeRegExp(item.value)}`,
        "m",
      );
      const passed = pattern.test(content);
      return {
        item,
        passed,
        reason: passed
          ? `包含章节「${item.value}」`
          : `缺少章节「${item.value}」`,
      };
    }

    // A manual item is the user's verdict to give, never the Auditor's: the
    // non-empty check is not a pass, so it must not silently turn green.
    return {
      item,
      passed: false,
      undetermined: true,
      reason: `人工项「${item.note}」需要你亲自判定，Auditor 不代判`,
    };
  });
}

/** Undetermined items are excluded: they are pending, not failed. */
export function checklistPassed(results: AcceptanceResult[]): boolean {
  return results.every(
    (result) => !result.item.required || result.passed || result.undetermined,
  );
}

export function undeterminedCount(results: AcceptanceResult[]): number {
  return results.filter((result) => result.undetermined).length;
}
