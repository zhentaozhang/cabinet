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

    if (item.type === "judge") {
      // 判卷要读语义，确定性规则给不出结论：这里只能如实说"没判"，
      // 交给有模型时的 judgeSubmission 回填。标成 passed 会把没判过的项
      // 显示成通过；标成失败又会让没有模型的环境一律驳回任务。
      return {
        item,
        passed: false,
        undetermined: true,
        reason: `需要模型判定：${item.value}`,
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

/**
 * 一张验收清单的三种结论。之所以不是布尔："没有结论"既不是通过也不是驳回，
 * 把两种否定折叠成 false 会让"没人判过"和"判过但没过"在页面上长得一样。
 *
 * - pass：所有 required 项都有结论且都通过；
 * - fail：至少一个 required 项有明确的否定结论；
 * - needs_review：没有失败项，但有 required 项没结论（模型没配、判卷超时、人工项）。
 */
export type AuditVerdict = "pass" | "fail" | "needs_review";

/**
 * 审计结论的唯一判定入口。undetermined 在这里既不等于通过也不等于失败：
 * 它让整张清单停在 needs_review，等一个真正给出结论的人（模型或用户）。
 *
 * 空清单返回 pass 只是逻辑上的平凡通过——没有 required 项，就不存在"有项没结论"。
 * "任务根本没有验收清单"不是这里能回答的问题：那种任务的结论由审计命令单独写一条
 * 人工待判项得出，见 commands/tasks/audit.ts 的无清单分支。
 */
export function auditVerdict(results: AcceptanceResult[]): AuditVerdict {
  const required = results.filter((result) => result.item.required);
  // 明确失败优先于待判：一条 required 项已被判否，就没必要再等另一条待判项，
  // 否则一份明显不合格的产物会因为"还有项没判"而停在待判定。
  if (required.some((result) => !result.passed && !result.undetermined)) {
    return "fail";
  }
  if (required.some((result) => result.undetermined)) return "needs_review";
  return "pass";
}

/**
 * 语义已收紧：存在未判定的 required 项时返回 false（从前返回 true，等于让
 * "判卷没有结论"冒充通过）。保留这个导出只为兼容既有的布尔调用方，
 * 新代码请用 auditVerdict 区分"驳回"和"待判定"。
 */
export function checklistPassed(results: AcceptanceResult[]): boolean {
  return auditVerdict(results) === "pass";
}

export function undeterminedCount(results: AcceptanceResult[]): number {
  return results.filter((result) => result.undetermined).length;
}
