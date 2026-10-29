import type { WeeklyMetricsDto } from "@/contracts";
import { actionTypeLabel } from "@/contracts/labels";
import { dateTime, money, shortDate } from "@/lib/format";
// 学习模板清单只有一份（domain 里那份）：这里曾经抄了一份，加第三种模板时
// 页面会悄悄不认它。
import { LEARNING_TEMPLATES } from "@/lib/domain/learning";
import { RECALL_CELL_HINT } from "@/lib/presentation/recall-view";

/**
 * Presentation rules for the Today page.
 *
 * Two things live here and nowhere else:
 *  - how a task or an agent is described in words (not ids), and
 *  - the unit each weekly metric is measured in.
 *
 * The unit question is not cosmetic. `weeklyMetrics` mixes two conventions:
 * `recallAvg` is a 0–1 ratio, while `adherence`, `retestPassRate` and
 * `goalProgress` are already 0–100 percentages. Multiplying the wrong one by
 * 100 renders a plausible-looking but false number, which is exactly the kind
 * of thing a dashboard must never do.
 */

/**
 * Statuses that are over as far as "what should I do next" is concerned.
 *
 * Deliberately not the same set the Today queue uses: `failed` is closed here
 * (it must not be recommended as the next learning step or offered as a
 * check-in candidate) yet open in src/server/services/queries/today.ts, because
 * a failure is exactly the thing the reader has to look at. "Finished as
 * work" and "needs a decision" are two different questions; collapsing them
 * into one list is what made failed tasks show up as progress.
 */
const CLOSED_TASK_STATUSES = ["done", "accepted", "failed", "cancelled"];

export function getProvenanceLabel(createdBy: string): string {
  if (createdBy === "user") return "用户手动";
  if (createdBy === "agent") return "Agent 自主";
  if (createdBy === "system") return "系统调度";
  return `来源: ${createdBy}`;
}

/**
 * What kind of task this is, in words.
 *
 * `template` and `actionType` are API enums. Neither may reach the reader
 * verbatim — `internal_read` and `custom_flow` are internal identifiers, and a
 * dashboard that prints them is showing its plumbing. Template gets the first
 * word only because the two learning templates are the only ones with a
 * meaningfully different label; every other template is described by what the
 * task actually does.
 */
export function getTaskTypeLabel(task: {
  template: string | null;
  actionType: string;
}): string {
  if (task.template === "learning") return "针对性学习";
  if (task.template === "learning_retest") return "间隔复测";
  if (task.actionType) return actionTypeLabel(task.actionType);
  return "常规任务";
}

/**
 * The single next learning step, or nothing.
 *
 * Deliberately returns the first match in list order rather than "most
 * urgent": the Today page offers one action, and reordering it by due date
 * would make the recommendation jump around between refreshes.
 */
export function pickLearningTask<
  T extends { id: string; template: string | null; status: string },
>(
  tasks: readonly T[],
  options?: { excludeIds?: ReadonlySet<string> },
): T | undefined {
  const excludeIds = options?.excludeIds;
  return tasks.find(
    (task) =>
      (LEARNING_TEMPLATES as readonly string[]).includes(task.template ?? "") &&
      !CLOSED_TASK_STATUSES.includes(task.status) &&
      !(excludeIds?.has(task.id) ?? false),
  );
}

/**
 * Statuses that mean "this task is waiting on you, not on an agent".
 *
 * This is a presentation grouping, not a domain status: every value here is an
 * existing entry in `TASK_STATUSES`, and no new status is introduced. Keeping
 * the list short is deliberate — a task in `running` or `planned` needs nothing
 * from the reader and belongs in the secondary list instead.
 */
const ATTENTION_TASK_STATUSES = [
  // 待判定排在最前：它是唯一一件"不处理就永远停在这里"的事，
  // 驳回和失败至少已经给出了一个结论。
  "needs_review",
  "awaiting_approval",
  "rejected",
  "failed",
  // 建议也等人：L1 的 Agent 跑完只会把方案写成 `suggested`，任务页自己的横幅
  // 就写着"等待你审核 · 由主理人确认采纳后方可继续"。漏掉它，Today 会把这个
  // 任务列在"其他推进中的任务"里冒充进展（卡片徽章还数成"进行中"），而页头的
  // "待处理"是 0——同一件事在两处说两个数。它排最后：其他几件都是已经停下来
  // 的结论，这一件至少还有一份草稿可看。
  "suggested",
];

/**
 * Fixed order inside the queue; index is the rank.
 *
 * Derived from the statuses above instead of being written out again: two
 * copies of the same literal drift, and a status that ranks but never matches
 * (or the reverse) silently reorders the queue.
 */
const ATTENTION_TASK_ORDER: readonly string[] = [...ATTENTION_TASK_STATUSES];

/** What each attention status asks the reader to do, in one line. */
const ATTENTION_TASK_HINTS: Record<string, string> = {
  needs_review: "验收没有给出结论，需要你判定通过或驳回。",
  awaiting_approval: "需要你批准后才会真正执行。",
  rejected: "被驳回，需要你查看原因并修改或重试。",
  failed: "执行失败，需要你判断是否重试。",
  suggested: "Agent 只交了建议，等你采纳或驳回，任务才不会停在这里。",
};

export type TodayActionKind = "approval" | "council" | "task";

export type TodayActionItem = {
  /** Stable identity across renders, unique inside one queue. */
  key: string;
  kind: TodayActionKind;
  /** The approval id, council id, or task id this item stands for. */
  refId: string;
  title: string;
  detail: string;
  /** What the reader should do, in one sentence. */
  hint: string;
  /** An existing app route — never a route that has to be invented. */
  href: string;
  /** The task status when this item is a task; null for approvals/councils. */
  status: string | null;
};

export type TodayActionQueue = {
  items: TodayActionItem[];
  counts: { approval: number; council: number; task: number; total: number };
  isEmpty: boolean;
  /** Always populated, so the empty region has stable copy. */
  empty: { title: string; hint: string };
};

export type TodayActionInput = {
  approvals: readonly {
    id: string;
    taskId: string | null;
    action: string;
    payload: Record<string, unknown>;
  }[];
  council: { id: string; topic: string; trigger: string } | null;
  tasks: readonly {
    id: string;
    title: string;
    status: string;
    dueAt: string | null;
  }[];
  /**
   * The reader's zone. Required, not optional: every date in this queue is a
   * promise about *when* something happens, and reading one in UTC is how an
   * approval due at 05:00 local gets shown as the previous day.
   */
  timeZone: string;
};

const EMPTY_QUEUE_COPY = {
  title: "没有需要你处理的事",
  // A council meeting is always rendered when one is open, so the empty state
  // has to name it too - otherwise the copy contradicts the queue.
  hint: "审批、内阁决议、待你审核的建议、被驳回与执行失败的任务会出现在这里；现在可以推进下一项任务。",
};

/** True when the task is blocked on a human decision rather than on an agent. */
export function needsAttention(status: string): boolean {
  return ATTENTION_TASK_STATUSES.includes(status);
}

/**
 * Statuses where an Agent still owes the next move.
 *
 * An explicit allowlist, not "everything that is not closed": `failed` and
 * `awaiting_approval` are open tasks too (src/server/services/queries/today.ts
 * returns them), but they are waiting on a human decision, so counting them as
 * "推进中" claims progress on work that is actually stuck. Anything not listed
 * here - including a status added later - counts as not in flight, which
 * under-reports rather than inventing movement.
 */
const IN_FLIGHT_TASK_STATUSES = [
  "planned",
  "assigned",
  "approved",
  "running",
  "submitted",
  "accepted",
];

/** The tasks an Agent is actually pushing, in the order given. */
export function inFlightTasks<T extends { status: string }>(
  tasks: readonly T[],
): T[] {
  return tasks.filter((task) => IN_FLIGHT_TASK_STATUSES.includes(task.status));
}

/**
 * How many open tasks the stored brief was generated from.
 *
 * `regenerateBrief` writes that count into `reviews.metrics.tasks` at the
 * moment it renders the text. The badge under the brief used to print the
 * *current* in-flight count instead, so a brief written when five tasks were
 * open started claiming it was based on one as soon as four of them finished —
 * a provenance claim that silently rewrote itself.
 *
 * Returns null for rows written before the metric existed; the caller then says
 * only what it knows rather than borrowing today's number.
 */
export function briefTaskSnapshot(
  brief: { metrics: Record<string, number | string> } | null | undefined,
): number | null {
  return cents(brief?.metrics?.tasks);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cents(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dueRank(dueAt: string | null): number {
  if (!dueAt) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(dueAt);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * When the approved action would happen, in the reader's zone.
 *
 * Two writers exist and both are real: the approvals command stores an ISO
 * `dueAt` (src/server/services/commands/tasks/approvals.ts), while the seed
 * stores a human-written `time` ("周三 20:00"). Reading only one of them made
 * most approvals render without their time at all.
 */
function approvalWhen(
  payload: Record<string, unknown>,
  timeZone: string,
): string {
  const dueAt = text(payload.dueAt);
  // Payloads are untyped JSON: a malformed date would make Intl throw and take
  // the whole page down, so it falls back to the written time instead.
  if (dueAt && !Number.isNaN(Date.parse(dueAt))) {
    return dateTime(dueAt, timeZone);
  }
  return text(payload.time);
}

function approvalItem(
  approval: TodayActionInput["approvals"][number],
  timeZone: string,
): TodayActionItem {
  const { payload } = approval;
  const title =
    text(payload.title) || text(payload.provider) || "待批准的外部动作";
  const cost = cents(payload.estimatedCostCents) ?? cents(payload.costCents);
  const reason = text(payload.reason) || text(payload.note);
  const parts: string[] = [];
  // "When" comes first: it is the fact the decision turns on.
  const when = approvalWhen(payload, timeZone);
  if (when) parts.push(when);
  if (cost !== null) parts.push(money(cost));
  if (reason) parts.push(reason);
  return {
    key: `approval:${approval.id}`,
    kind: "approval",
    refId: approval.id,
    title,
    detail: parts.join(" · "),
    hint: ATTENTION_TASK_HINTS.awaiting_approval,
    // The decision itself happens inline on this page; the link only carries
    // context. Without a task there is no deeper surface to open.
    href: approval.taskId ? `/tasks/${approval.taskId}` : "/cabinet",
    status: null,
  };
}

/**
 * One ordered list of everything that is waiting on the reader.
 *
 * Order is approvals (as the API returned them), then the open council meeting,
 * then attention tasks sorted `awaiting_approval` → `rejected` → `failed`, and
 * inside one status by due date (undated last) and finally by id. The order is
 * a pure function of the input, so it cannot drift between refreshes.
 */
export function buildTodayActionQueue(
  input: TodayActionInput,
): TodayActionQueue {
  const items: TodayActionItem[] = input.approvals.map((approval) =>
    approvalItem(approval, input.timeZone),
  );

  if (input.council) {
    items.push({
      key: `council:${input.council.id}`,
      kind: "council",
      refId: input.council.id,
      title: `内阁会议：${input.council.topic}`,
      detail: input.council.trigger,
      hint: "需要你在决策室定方向。",
      href: "/council",
      status: null,
    });
  }

  const attention = input.tasks
    .filter((task) => needsAttention(task.status))
    .sort((a, b) => {
      const rank =
        ATTENTION_TASK_ORDER.indexOf(a.status) -
        ATTENTION_TASK_ORDER.indexOf(b.status);
      if (rank !== 0) return rank;
      const byDue = dueRank(a.dueAt) - dueRank(b.dueAt);
      if (byDue !== 0) return byDue;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  for (const task of attention) {
    items.push({
      key: `task:${task.id}`,
      kind: "task",
      refId: task.id,
      title: task.title,
      // A deadline is a local date like every other date on this page; slicing
      // the ISO string printed the UTC day, which is the previous one for most
      // evening deadlines in Asia/Shanghai.
      detail: task.dueAt
        ? `截止 ${shortDate(task.dueAt, input.timeZone)}`
        : "未设置截止时间",
      hint: ATTENTION_TASK_HINTS[task.status] ?? "需要你确认下一步。",
      href: `/tasks/${task.id}`,
      status: task.status,
    });
  }

  const counts = {
    approval: items.filter((item) => item.kind === "approval").length,
    council: items.filter((item) => item.kind === "council").length,
    task: items.filter((item) => item.kind === "task").length,
    total: items.length,
  };

  return {
    items,
    counts,
    isEmpty: items.length === 0,
    empty: EMPTY_QUEUE_COPY,
  };
}

/** Task ids the queue already shows, so no second list repeats them. */
export function queuedTaskIds(queue: TodayActionQueue): Set<string> {
  return new Set(
    queue.items.filter((item) => item.kind === "task").map((item) => item.refId),
  );
}

/** The tasks left for the secondary list: input order minus the queue. */
export function secondaryTasks<T extends { id: string }>(
  tasks: readonly T[],
  queue: TodayActionQueue,
): T[] {
  const seen = queuedTaskIds(queue);
  return tasks.filter((task) => !seen.has(task.id));
}


/**
 * A ratio stored as 0–1 (`recallAvg`), rendered as a percentage.
 * `null` means "no samples", which is different from zero.
 */
export function formatRatioAsPercent(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value * 100)}%`;
}

/**
 * A value already stored as 0–100 (`adherence`, `retestPassRate`,
 * `goalProgress`). Must not be multiplied again.
 */
export function formatPercentValue(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value)}%`;
}

export type WeeklyMetricRow = {
  key: string;
  label: string;
  value: string;
  hint: string;
};

/**
 * The six weekly numbers, each formatted by its own unit.
 * Kept together so a future metric cannot silently copy the wrong helper.
 */
export function weeklyMetricRows(
  weekly: Pick<
    WeeklyMetricsDto,
    | "studyMinutes"
    | "recallAvg"
    | "adherence"
    | "learningTasks"
    | "retestPassRate"
    | "goalProgress"
  >,
): WeeklyMetricRow[] {
  return [
    {
      key: "study",
      label: "学习专注",
      value: `${weekly.studyMinutes}m`,
      hint: "本周学习分钟数",
    },
    {
      key: "recall",
      label: "回忆正确率",
      value: formatRatioAsPercent(weekly.recallAvg),
      hint: RECALL_CELL_HINT,
    },
    {
      key: "adherence",
      label: "计划遵从率",
      value: formatPercentValue(weekly.adherence),
      hint: "按时推进度",
    },
    {
      key: "learning",
      label: "学习任务",
      value: String(weekly.learningTasks),
      hint: "本周验收的学习任务",
    },
    {
      key: "retest",
      label: "复测通过率",
      value: formatPercentValue(weekly.retestPassRate),
      hint: "长期记忆留存",
    },
    {
      key: "goal",
      label: "目标总进度",
      value: formatPercentValue(weekly.goalProgress),
      hint: "学习目标进度",
    },
  ];
}
