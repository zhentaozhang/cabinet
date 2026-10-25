import type { AcceptanceItem } from "@/lib/db/schema";

/**
 * A task's acceptance criteria, in a shape someone outside this system can act
 * on.
 *
 * The acceptance checklist already lives in the database, but as `jsonb` it
 * only means something to `evaluateAcceptance`. Exporting it turns "what would
 * count as done" into a contract the requester, the executor and a third-party
 * reviewer can all read the same way — and the export deliberately carries no
 * timestamp and no id generation, so the same task always produces the same
 * bytes and two exports can be diffed.
 */
export const ACCEPTANCE_CONTRACT_VERSION = 1;

export type AcceptanceCheck = {
  /** Positional and stable: `<index>-<type>`, never a random id. */
  id: string;
  type: AcceptanceItem["type"];
  required: boolean;
  /** One sentence a reader who has never seen this codebase can act on. */
  statement: string;
  /**
   * Machine-checkable parameters, or null when only a human can settle it.
   * Deliberately not the raw item: the raw item's key names (`value` for six
   * types, `note` for one) are an implementation detail.
   */
  spec: Record<string, unknown> | null;
  /** True when this project cannot decide the rule itself. */
  undetermined: boolean;
};

export type AcceptanceContract = {
  version: number;
  taskId: string;
  title: string;
  /** The prose criteria the human wrote, kept verbatim next to the checklist. */
  criteria: string;
  checks: AcceptanceCheck[];
};

function specOf(item: AcceptanceItem): {
  statement: string;
  spec: Record<string, unknown> | null;
  undetermined: boolean;
} {
  switch (item.type) {
    case "section":
      return {
        statement: "必须包含小节 «" + item.value + "»",
        spec: { section: item.value },
        undetermined: false,
      };
    case "min_words":
      return {
        statement: "正文至少 " + item.value + " 字（汉字按 1 字计，其余按空白分词）",
        spec: { minWords: item.value },
        undetermined: false,
      };
    case "min_sources":
      return {
        statement:
          "正文至少引用 " +
          item.value +
          " 个链接（只统计链接数量，不验证可达性，也不验证它是否真的支持结论）",
        spec: { minSources: item.value },
        undetermined: false,
      };
    case "min_evidence":
      return {
        statement:
          "至少 " +
          item.value +
          " 条检索证据，且必须以 [cite:evd_…] 指向真实存在的证据行（编造的引用不算）",
        spec: { minEvidence: item.value, citation: "[cite:evd_…]" },
        undetermined: false,
      };
    case "contains":
      return {
        statement: "正文必须包含 «" + item.value + "»",
        spec: { contains: item.value },
        undetermined: false,
      };
    case "claims_table":
      return {
        statement: "必须包含断言表，且至少 " + item.value + " 行可核对的断言",
        spec: { claimsTableRows: item.value },
        undetermined: false,
      };
    case "manual":
      return {
        statement: "人工判定：" + item.note,
        spec: null,
        undetermined: true,
      };
  }
}

/**
 * Turn a checklist into an exportable contract.
 *
 * A task with no checklist exports a single undetermined line instead of an
 * empty list: an empty list reads as "nothing to check", which is exactly the
 * sentence that let an Auditor claim a comparison that never happened.
 */
export function exportAcceptanceContract(input: {
  taskId: string;
  title: string;
  criteria: string;
  checklist: AcceptanceItem[] | null | undefined;
}): AcceptanceContract {
  const items = input.checklist ?? [];
  const checks: AcceptanceCheck[] =
    items.length === 0
      ? [
          {
            id: "0-manual",
            type: "manual",
            required: true,
            statement:
              "人工判定：本任务没有验收清单，导出方没有逐条对照；请人工确认「" +
              (input.criteria.trim() || input.title) +
              "」是否满足",
            spec: null,
            undetermined: true,
          },
        ]
      : items.map((item, index) => {
          const { statement, spec, undetermined } = specOf(item);
          return {
            id: index + "-" + item.type,
            type: item.type,
            required: item.required,
            statement,
            spec,
            undetermined,
          };
        });

  return {
    version: ACCEPTANCE_CONTRACT_VERSION,
    taskId: input.taskId,
    title: input.title,
    criteria: input.criteria,
    checks,
  };
}

/**
 * The same contract as Markdown, for the person who will sign it off.
 *
 * Undetermined lines are labelled in the document, not just in the JSON: a
 * reviewer reading the rendered version must not have to open the JSON to learn
 * that one line was never checked.
 */
export function renderAcceptanceContract(contract: AcceptanceContract): string {
  const lines = [
    "# 验收契约：" + contract.title,
    "",
    "- 任务：`" + contract.taskId + "`",
    "- 契约版本：" + contract.version,
    "- 验收清单：" + contract.checks.length + " 项",
    "",
    "## 原始验收标准",
    "",
    contract.criteria.trim() || "（无）",
    "",
    "## 逐条契约",
    "",
  ];

  contract.checks.forEach((check, index) => {
    lines.push(
      (index + 1) +
        ". **" +
        (check.required ? "必过" : "可选") +
        "** · " +
        check.type +
        (check.undetermined ? " · 需人工判定" : "") +
        " — " +
        check.statement,
    );
  });

  const undetermined = contract.checks.filter((check) => check.undetermined);
  if (undetermined.length > 0) {
    lines.push(
      "",
      "> " +
        undetermined.length +
        " 项需要人工判定：这些规则本仓库自己不能作出结论，导出方不会把它们算作通过。",
    );
  }

  return lines.join("\n") + "\n";
}
