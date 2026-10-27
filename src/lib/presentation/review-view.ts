/**
 * Presentation rules for the Review page: wording, badges and the small
 * orderings the page needs. No policy lives here — everything that decides
 * something stays in `src/lib/domain/policy.ts` and in the command layer.
 */

import type { TaskStatus } from "@/contracts/dto/entities";
import type { UpgradeDenialCode } from "@/lib/domain/policy";

/** The highest rung this MVP can hand out; `policy.ts:544-546` denies anything above. */
export const MAX_AUTONOMY_LEVEL = 3;

export type AutonomyDecision = {
  allowed: boolean;
  level: number;
  code: string | null;
  reason: string;
  samples: number;
  passRate: number;
};

/**
 * Typed with the policy union rather than `Record<string, string>`: a code
 * added to `UpgradeDenialCode` then fails the build until it has a word here.
 * The previous shape let a missing label degrade into the "保持" fallback in
 * silence, which reads as a policy decision instead of a missing translation.
 */
export const DENIAL_LABELS: Record<UpgradeDenialCode, string> = {
  insufficient_samples: "样本不足",
  low_pass_rate: "通过率不足",
  low_trust: "信用不足",
  too_few_successes: "成功次数不足",
  not_eligible_role: "不在岗",
  retired: "已退休",
  paused: "已暂停",
};

/**
 * Widened view of the same map. `decision.code` is a plain string on the wire,
 * so an unknown code must still reach the "保持" fallback rather than crash a
 * page; the typed map above stays the source of truth for what we cover.
 */
const DENIAL_LABEL_LOOKUP: Readonly<Record<string, string>> = DENIAL_LABELS;

/**
 * Renders the verdict the command layer already made. This function must never
 * compare thresholds itself: the badge and the promotion write have to agree,
 * and only the backend knows which audits count as evidence.
 */
export function recommendation(
  agent: {
    role: string;
    lifecycleStage: string;
    autonomyLevel: number;
    failCount: number;
    successCount: number;
  },
  decision: AutonomyDecision | undefined,
) {
  if (agent.role === "apprentice" && agent.lifecycleStage !== "active") {
    return { label: "待转正", tone: "accent" as const, title: "学徒需先通过转正考核。" };
  }
  if (agent.failCount > agent.successCount) {
    return {
      label: "考虑退休",
      tone: "danger" as const,
      title: "驳回次数多于通过次数。",
    };
  }
  if (!decision) {
    return { label: "暂无结论", tone: "neutral" as const, title: "尚未计算授权结论。" };
  }
  if (decision.allowed) {
    // `autonomy.ts:103` clamps the target at 3 and `policy.ts:548-550` allows a
    // same-level move, so an Agent already at the top rung always comes back
    // `allowed: true`. Calling that "可升级" promises a promotion the backend
    // cannot perform, and the sample counts next to it read as its evidence.
    if (decision.level <= agent.autonomyLevel) {
      // Only promise the ceiling when the Agent is actually standing on it.
      // `loadAutonomyDecisions` takes `nextLevelOffset` as a parameter, so a
      // caller that passes 0 makes a same-level verdict reachable below L3 too;
      // printing "已达上限" there would invent a cap that does not exist.
      const atTop = agent.autonomyLevel >= MAX_AUTONOMY_LEVEL;
      return {
        label: atTop ? "已达上限" : "维持当前等级",
        tone: "neutral" as const,
        title: atTop
          ? `已在 L${agent.autonomyLevel}，MVP 最高档；本次结论只是维持当前等级。`
          : `已在 L${agent.autonomyLevel}，本次结论不提高等级。`,
      };
    }
    return {
      label: "可升级",
      tone: "teal" as const,
      title: `${decision.samples} 个有效样本，通过率 ${(decision.passRate * 100).toFixed(0)}%。`,
    };
  }
  const label = decision.code ? DENIAL_LABEL_LOOKUP[decision.code] : undefined;
  return {
    label: label ?? "保持",
    tone: (decision.code === "paused" || decision.code === "retired"
      ? "danger"
      : "neutral") as "danger" | "neutral",
    title: decision.reason,
  };
}

export const DISSENT_STATUS: Record<
  string,
  { label: string; tone: "accent" | "teal" | "neutral" }
> = {
  pending: { label: "观察中", tone: "accent" },
  vindicated: { label: "已平反", tone: "teal" },
  invalidated: { label: "已证伪", tone: "neutral" },
};

export type ListPageState = "empty" | "out-of-range" | "ok";

/**
 * Distinguishes "there is nothing" from "this page is past the end".
 *
 * `review.ts:28-29` only clamps the offset at 0; it never folds a stale offset
 * back inside `total`. So an empty page can still have rows behind it, and
 * saying "本周没有产生新洞察" there contradicts the footer's 共 N.
 */
export function listPageState(total: number, pageCount: number): ListPageState {
  if (total === 0) return "empty";
  if (pageCount === 0) return "out-of-range";
  return "ok";
}

/**
 * Statuses where a task is still something a person can push forward.
 * Anything else is history and does not belong in "next week's one goal".
 *
 * Intentional divergence with Today: Today also surfaces `failed` tasks because
 * a failure there needs a decision, while Review leaves them out — next week's
 * single goal must be something still in play, not something already given up.
 */
export const OPEN_TASK_STATUS: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "planned",
  "assigned",
  "awaiting_approval",
  "approved",
  "suggested",
  "running",
  "submitted",
  "auditing",
  // 待判定是"还活着、等人推一把"的任务：从周目标里去掉它，
  // 等于让一次没给出结论的验收把这件事从下周计划里抹掉。
  "needs_review",
  "rejected",
]);

export type FocusTaskInput = {
  status: TaskStatus;
  priority: number;
  dueAt: string | null;
};

/**
 * The one task next week is allowed to be about: highest priority among open
 * work, earliest deadline to break the tie.
 *
 * A task with no deadline sorts last instead of first. `"".localeCompare(date)`
 * put every unbounded task ahead of every dated one, which is the opposite of
 * what the copy promises and quietly made an open-ended idea the week's goal.
 */
export function pickFocusTask<T extends FocusTaskInput>(
  tasks: readonly T[],
): T | undefined {
  const open = tasks
    .filter((task) => OPEN_TASK_STATUS.has(task.status))
    .sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      if (a.dueAt === b.dueAt) return 0;
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      return a.dueAt.localeCompare(b.dueAt);
    });
  return open[0];
}