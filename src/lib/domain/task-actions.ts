/**
 * What a person may do to a task right now, and why not.
 *
 * The buttons used to be rendered from the task's status inline in JSX, so the
 * page's copy drifted from what the server would actually do — a click that
 * always fails is indistinguishable from a broken page.
 *
 * Scope: this describes what the page should OFFER. The command layer stays
 * tolerant on purpose (`runTask` on an already-executed task is refused by
 * policy, not by a status check), so this function is allowed to be stricter
 * than the API — never looser.
 */

import type { TaskStatus } from "@/contracts/dto/entities";

export type TaskActionState = {
  allowed: boolean;
  /** Shown on the button when it cannot be used; empty when allowed. */
  reason: string;
};

export type TaskActions = {
  run: TaskActionState;
  audit: TaskActionState;
  promote: TaskActionState;
  cancel: TaskActionState;
};

export type TaskActionInput = {
  status: string;
  hasAssignee: boolean;
  hasAuditor: boolean;
};

const RUNNABLE = new Set(["planned", "assigned", "approved", "rejected", "failed"]);

/**
 * Cancelling stops work; it never removes the record.
 *
 * A running task is cancellable too: refusing it only helped when a live run
 * could still write back into a closed task. The cancel command now closes the
 * run, its job and the budget hold in the same transaction, and the run's own
 * write-back is guarded by `status = 'running'` — so the button can be offered
 * instead of leaving an abandoned task unstoppable forever.
 */
const CANCELLABLE = new Set([
  "planned",
  "assigned",
  "suggested",
  "awaiting_approval",
  "approved",
  "rejected",
  "failed",
  "running",
  // 待判定也允许放弃：状态图里 needs_review → cancelled 是合法边，
  // 否则一个"没人给结论"的任务会永远卡在队列里，既不能验收也不能关掉。
  "needs_review",
]);

const CANCEL_REASON: Record<string, string> = {
  submitted: "已提交，验收期间不能取消",
  auditing: "正在验收，不能取消",
  accepted: "已通过验收，记录不可撤回",
  done: "已完成",
  cancelled: "已取消",
};

const RUN_REASON: Record<string, string> = {
  needs_review: "验收缺少结论，先做判定，再决定是否重跑",
  awaiting_approval: "等待你批准这次外部动作",
  submitted: "已提交，等待验收",
  auditing: "正在验收",
  suggested: "先采纳建议，才能执行",
  accepted: "已通过验收",
  done: "已完成",
  cancelled: "已取消",
};

const AUDIT_REASON: Record<string, string> = {
  needs_review: "验收没有给出结论，等你判定后才谈得上重新验收",
  planned: "还没有执行，没有可验收的产物",
  assigned: "还没有执行，没有可验收的产物",
  awaiting_approval: "先批准这次外部动作",
  approved: "批准后还要执行，才有产物",
  running: "正在执行",
  rejected: "已驳回；重新执行后才会再次进入验收",
  failed: "执行失败，没有可验收的产物",
  accepted: "已通过验收",
  done: "已完成",
  cancelled: "已取消",
};

function decide(
  allowed: boolean,
  reason: string | undefined,
  fallback: string,
): TaskActionState {
  return allowed ? { allowed: true, reason: "" } : { allowed: false, reason: reason ?? fallback };
}

export function taskActions(input: TaskActionInput): TaskActions {
  const { status, hasAssignee, hasAuditor } = input;

  const run = decide(
    RUNNABLE.has(status) && hasAssignee,
    hasAssignee ? RUN_REASON[status] : "任务没有执行者",
    "当前状态不能执行",
  );

  // `auditTask` locks the row in `submitted`; anywhere else it is a guaranteed
  // conflict, so the button must not pretend.
  const audit = decide(
    status === "submitted" && hasAuditor,
    hasAuditor ? AUDIT_REASON[status] : "任务没有验收者",
    "当前状态不能验收",
  );

  const promote = decide(status === "suggested", "只有「建议」状态需要采纳", "无需采纳");

  const cancel = decide(
    CANCELLABLE.has(status),
    CANCEL_REASON[status],
    "当前状态不能取消",
  );

  return { run, audit, promote, cancel };
}

/**
 * 「还没了结」的任务：下周一唯一目标只能从这些里挑。
 *
 * 与今日页有意不同 —— 今日页也列 `failed`（它要你做一个决定），周目标不列：
 * 下周要做的事必须是还活着的事，不是已经放弃的事。
 */
export const OPEN_TASK_STATUSES = [
  "planned",
  "assigned",
  "awaiting_approval",
  "approved",
  "suggested",
  "running",
  "submitted",
  "auditing",
  // 待判定是「还活着、等人推一把」的任务：从周目标里去掉它，等于让一次没给出
  // 结论的验收把这件事从下周计划里抹掉。
  "needs_review",
  "rejected",
] as const;

export const OPEN_TASK_STATUS: ReadonlySet<TaskStatus> =
  new Set<TaskStatus>(OPEN_TASK_STATUSES);
