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

    const passed = content.trim().length > 0;
    return {
      item,
      passed,
      reason: passed
        ? `人工项「${item.note}」：产物非空，需 Auditor 复核`
        : `人工项「${item.note}」：产物为空`,
    };
  });
}

export function checklistPassed(results: AcceptanceResult[]): boolean {
  return results.every((result) => !result.item.required || result.passed);
}
