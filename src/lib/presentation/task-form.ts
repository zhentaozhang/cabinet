/**
 * Validation for the progressive task form, kept out of the component so the
 * ordering rules can be tested without a browser.
 *
 * Two things here are easy to get wrong and both were:
 *
 *  1. `focus` names the *first* problem in reading order, not the last one
 *     found. Returning errors in an unordered object and then checking them in
 *     an ad-hoc `if/else` chain meant the field a person was sent to depended on
 *     the order someone happened to write the branches.
 *  2. Some fields live inside the collapsed 「更多配置」 block. Reporting an error
 *     on a hidden field without also opening that block leaves the person told
 *     "请指定验收者" with nothing on screen to fix — so how to reach that field is
 *     decided here too, by `planAdvancedFocus`, rather than re-derived by the
 *     caller.
 */

import { assigneeBlockReason, type AssigneeBlockReason } from "@/lib/domain/policy";

export type TaskDraftErrors = {
  title?: string;
  acceptanceCriteria?: string;
  description?: string;
  auditor?: string;
  cost?: string;
};

/** Fields that only exist once 「更多配置」 is expanded. */
export type AdvancedField = "auditor" | "cost";

export type TaskDraft = {
  title: string;
  acceptanceCriteria: string;
  description: string;
  auditorId: string;
  assigneeId: string;
  actionType: string;
  costYuan: string;
};

export type TaskValidation = {
  errors: TaskDraftErrors;
  /** The control to move focus to, in reading order. */
  focus: "title" | "acceptanceCriteria" | "description" | AdvancedField | null;
  valid: boolean;
};

/**
 * The two strings the form compares across functions, exported so the producer
 * (validation) and the consumer (quick-create's instant field handlers) cannot
 * drift apart. A literal compared by equality used to break silently: editing
 * one copy made the stale-error clearing stop working with no test failure.
 */
export const AUDITOR_CONFLICT_MESSAGE = "验收者不能是执行者";
export const COST_FORMAT_MESSAGE = "费用需为数字，最多两位小数";
export const COST_AMOUNT_MESSAGE = "支出任务金额需大于 0 元";

/**
 * Parses a yuan amount typed by a person into integer cents.
 *
 * Deliberately strict: `parseFloat` accepted "12元" as 12, "12.5.5" as 12.5 and
 * "12abc" as 12, so a unit suffix or a typo was silently charged. Only plain
 * decimal amounts with at most two decimals are real money input.
 *
 * Rejected on purpose: a leading + or -, thousand separators ("1,000"),
 * exponent notation ("1e3"), full-width digits ("１２３"), a bare "." or "12.".
 * None of them is a format this UI offers, and guessing what a person meant with
 * money is worse than asking again.
 *
 * A blank string means "nothing entered" and yields `null`, never `0`: `0` is a
 * real amount and would pass a "<= 0" check as a value rather than a blank.
 */
export function yuanToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // \d stays ASCII-only here, so full-width digits fail instead of being
  // normalised into a charge.
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  // Number().toFixed-free rounding: 12.5 * 100 is 1250.0000000000002 in binary
  // floating point, and a truncating conversion would charge 12.49 元.
  const cents = Math.round(Number(trimmed) * 100);
  return Number.isFinite(cents) ? cents : null;
}

const ORDER = [
  "title",
  "acceptanceCriteria",
  "description",
  "auditor",
  "cost",
] as const satisfies readonly (keyof TaskDraftErrors)[];

export function validateTaskDraft(draft: TaskDraft): TaskValidation {
  const errors: TaskDraftErrors = {};

  if (!draft.title.trim()) errors.title = "写一句能被验收的标题";
  if (!draft.acceptanceCriteria.trim())
    errors.acceptanceCriteria = "验收标准决定 Auditor 怎么判";
  if (!draft.description.trim())
    errors.description = "描述范围，Agent 会照着做";

  if (!draft.auditorId) {
    errors.auditor = "请指定验收者";
  } else if (draft.assigneeId && draft.assigneeId === draft.auditorId) {
    // The Auditor must not be the agent whose work is being judged.
    errors.auditor = AUDITOR_CONFLICT_MESSAGE;
  }

  if (draft.actionType === "spend") {
    const cents = yuanToCents(draft.costYuan);
    if (cents === null) {
      // Blank means "not filled in yet"; anything else was unreadable as money.
      // Telling someone the amount must be > 0 when they typed 「12元」 hides the
      // actual problem — the format.
      const entered = draft.costYuan.trim();
      errors.cost = entered ? COST_FORMAT_MESSAGE : COST_AMOUNT_MESSAGE;
    } else if (cents <= 0) {
      errors.cost = COST_AMOUNT_MESSAGE;
    }
  }

  const first = ORDER.find((key) => errors[key] !== undefined) ?? null;

  return {
    errors,
    focus: first,
    valid: first === null,
  };
}

export type AdvancedFocusPlan =
  | { kind: "none" }
  | { kind: "focus-now"; field: AdvancedField }
  | { kind: "open-then-focus"; field: AdvancedField };

/**
 * Decides how to reach a field that lives in the collapsed 「更多配置」 block.
 *
 * The trap: focusing only from a `useEffect` keyed on `advancedOpen` looks
 * correct but silently does nothing when the block is *already* open — setting
 * `true` to `true` is a no-op, so the effect never re-runs. Someone who expanded
 * the block themselves and then submitted an invalid form got the error message
 * with focus left on the submit button. Whether the block is open has to change
 * the strategy, not just be a precondition.
 */
export function planAdvancedFocus(
  field: AdvancedField | null,
  advancedOpen: boolean,
): AdvancedFocusPlan {
  if (!field) return { kind: "none" };
  return advancedOpen
    ? { kind: "focus-now", field }
    : { kind: "open-then-focus", field };
}
/**
 * Which Agents the task form may offer as the assignee.
 *
 * A retired Agent is terminal (`state.ts`: `retired` has no outgoing edge) and a
 * trainee only becomes runnable by graduating, yet both used to sit in the
 * assignee dropdown with a preview saying 「将由 X 执行」 — a task handed to
 * either one can never run, because `decideRun` refuses a non-active status or
 * lifecycleStage before any run row exists. A paused Agent stays offerable: it
 * is one click from active and the task simply waits for that click.
 */
export type AgentChoice = {
  id: string;
  name: string;
  role: string;
  status: string;
  lifecycleStage: string;
};

export function assignableAgents<T extends AgentChoice>(
  agents: readonly T[],
): T[] {
  return agents.filter((agent) => {
    const reason = assigneeBlockReason(agent);
    // `off_duty` is reversible; the rest can never execute the task.
    return reason === null || reason === "off_duty";
  });
}

const BLOCK_LABEL: Record<AssigneeBlockReason, string> = {
  retired: "已退休，不能接单",
  trainee: "未转正，不能接单",
  off_duty: "已停岗",
};

/**
 * The suffix an unavailable Agent carries in the assignee dropdown, or `null`
 * when it can be picked. Kept next to `assignableAgents` so the option text and
 * the filtering rule cannot disagree about who is unavailable.
 */
export function assigneeBlockLabel(agent: AgentChoice): string | null {
  const reason = assigneeBlockReason(agent);
  if (reason === null || reason === "off_duty") return null;
  return BLOCK_LABEL[reason];
}
