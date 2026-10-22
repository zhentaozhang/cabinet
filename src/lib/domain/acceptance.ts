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
 * Deterministic checklist evaluator. It deliberately does not call a model:
 * the Auditor must be able to explain every pass/fail line.
 */
export function evaluateAcceptance(
  content: string,
  checklist: AcceptanceItem[],
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
      return {
        item,
        passed: count >= item.value,
        reason: `来源 ${count}，要求至少 ${item.value}`,
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
