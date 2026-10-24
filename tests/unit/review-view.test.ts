import { describe, expect, it } from "vitest";

import type { TaskStatus } from "@/contracts/dto/entities";
import {
  DENIAL_LABELS,
  DISSENT_STATUS,
  OPEN_TASK_STATUS,
  listPageState,
  pickFocusTask,
  recommendation,
  type AutonomyDecision,
} from "@/lib/presentation/review-view";

const healthyAgent = {
  role: "chief_of_staff",
  lifecycleStage: "active",
  autonomyLevel: 2,
  failCount: 1,
  successCount: 9,
};

/**
 * Hand-written on purpose. Iterating `DENIAL_LABELS` cannot notice a missing
 * key: drop one and the loop simply runs one fewer time, while `policy.ts`
 * keeps emitting that code and the page silently renders the "保持" fallback.
 * Keep this list in step with `UpgradeDenialCode` in
 * `src/lib/domain/policy.ts:504-511`; the `Record<UpgradeDenialCode, string>`
 * annotation on the map is what makes a new backend code a build error.
 */
const UPGRADE_DENIAL_CODES = [
  "insufficient_samples",
  "low_pass_rate",
  "low_trust",
  "too_few_successes",
  "not_eligible_role",
  "retired",
  "paused",
] as const;

function decision(overrides: Partial<AutonomyDecision>): AutonomyDecision {
  return {
    allowed: false,
    level: 2,
    code: null,
    reason: "保持当前等级。",
    samples: 0,
    passRate: 0,
    ...overrides,
  };
}

describe("recommendation renders the backend verdict and never re-decides it", () => {
  // The badge and the promotion write must agree. If this function ever starts
  // comparing thresholds itself, the two drift apart and the page promises a
  // promotion the command layer will not perform.
  it("shows an upgrade only when the decision allows one", () => {
    const rec = recommendation(
      healthyAgent,
      decision({ allowed: true, level: 3, samples: 12, passRate: 0.9166 }),
    );
    expect(rec.label).toBe("可升级");
    expect(rec.tone).toBe("teal");
    expect(rec.title).toContain("12");
    expect(rec.title).toContain("92%");
  });

  it("never shows an upgrade for a denied decision, however good the numbers look", () => {
    const rec = recommendation(
      { ...healthyAgent, successCount: 100, failCount: 0 },
      decision({ allowed: false, code: "low_trust", samples: 50, passRate: 1 }),
    );
    expect(rec.label).toBe("信用不足");
    expect(rec.label).not.toBe("可升级");
    expect(rec.tone).toBe("neutral");
  });

  it("explains a denial in words rather than printing its code", () => {
    for (const code of UPGRADE_DENIAL_CODES) {
      const label = DENIAL_LABELS[code];
      expect(label, code).toBeTruthy();
      expect(label.trim(), code).not.toBe("");
      const rec = recommendation(healthyAgent, decision({ allowed: false, code }));
      expect(rec.label, code).toBe(label);
    }
  });

  it("carries a label for every denial code the policy can emit, and no others", () => {
    // Both directions matter: a missing key falls back to "保持", and a key
    // nobody can reach is dead vocabulary that hides a renamed code.
    expect(Object.keys(DENIAL_LABELS).sort()).toEqual(
      [...UPGRADE_DENIAL_CODES].sort(),
    );
  });

  it("treats paused and retired as terminal, not as a neutral hold", () => {
    for (const code of ["paused", "retired"]) {
      const rec = recommendation(healthyAgent, decision({ allowed: false, code }));
      expect(rec.tone, code).toBe("danger");
    }
  });

  it("warns about retirement before it reads the denial code", () => {
    // Branch order matters and is deliberate: an Agent whose audits fail more
    // than they pass is already a liability, whatever code the command layer
    // attaches. Pin it so a future refactor cannot reorder the two.
    const rec = recommendation(
      { ...healthyAgent, failCount: 7, successCount: 3 },
      decision({ allowed: false, code: "retired" }),
    );
    expect(rec.label).toBe("考虑退休");
    expect(rec.tone).toBe("danger");
    expect(rec.label).not.toBe(DENIAL_LABELS.retired);
  });

  it("holds at the current level when a denial arrives without a code", () => {
    // `code === null` is a real shape: the policy returns "no code" whenever it
    // merely allows or withholds. Guessing a reason would be worse than saying
    // "hold", so this branch must stay visible instead of throwing.
    const rec = recommendation(
      healthyAgent,
      decision({ allowed: false, code: null, reason: "暂时保持当前等级。" }),
    );
    expect(rec.label).toBe("保持");
    expect(rec.tone).toBe("neutral");
    expect(rec.title).toBe("暂时保持当前等级。");
  });

  it("falls back to a neutral hold for an unknown denial code", () => {
    const rec = recommendation(
      healthyAgent,
      decision({ allowed: false, code: "some_new_rule", reason: "新的限制。" }),
    );
    expect(rec.label).toBe("保持");
    expect(rec.tone).toBe("neutral");
    expect(rec.title).toBe("新的限制。");
  });

  it("quotes the backend's own reason instead of inventing one", () => {
    const rec = recommendation(
      healthyAgent,
      decision({ allowed: false, code: "low_pass_rate", reason: "通过率 40% 低于门槛。" }),
    );
    expect(rec.title).toBe("通过率 40% 低于门槛。");
  });

  it("does not claim a verdict before one has been computed", () => {
    const rec = recommendation(healthyAgent, undefined);
    expect(rec.label).toBe("暂无结论");
    expect(rec.tone).toBe("neutral");
  });

  it("sends an apprentice to the exam before discussing autonomy", () => {
    const rec = recommendation(
      { ...healthyAgent, role: "apprentice", lifecycleStage: "examining" },
      decision({ allowed: true, samples: 20, passRate: 1 }),
    );
    expect(rec.label).toBe("待转正");
    expect(rec.label).not.toBe("可升级");
  });

  it("lets a graduated apprentice be judged on its audits like anyone else", () => {
    const rec = recommendation(
      { ...healthyAgent, role: "apprentice", lifecycleStage: "active" },
      decision({ allowed: true, level: 3, samples: 6, passRate: 0.83 }),
    );
    expect(rec.label).toBe("可升级");
  });

  it("does not promise an upgrade to an Agent that is already at the top rung", () => {
    // `autonomy.ts:103` clamps the target level at 3, and `policy.ts:548-550`
    // allows a same-level move. So an L3 Agent always gets `allowed: true` at
    // `level: 3`. Rendering "可升级" there promises a promotion that cannot
    // exist, and the sample counts beside it read as a made-up justification.
    const rec = recommendation(
      { ...healthyAgent, autonomyLevel: 3 },
      decision({ allowed: true, level: 3, samples: 12, passRate: 0.9166 }),
    );
    expect(rec.label).not.toBe("可升级");
    expect(rec.label).toBe("已达上限");
    expect(rec.tone).toBe("neutral");
    expect(rec.title).toContain("L3");
    expect(rec.title).toContain("最高");
  });

  it("says it keeps the current level, not the ceiling, below L3", () => {
    // Only reachable when a caller passes `nextLevelOffset: 0` to
    // `loadAutonomyDecisions` (the Review page passes 1). Guarding anyway: an
    // L2 Agent told "已达上限" would hear a cap that does not exist.
    const rec = recommendation(
      { ...healthyAgent, autonomyLevel: 2 },
      decision({ allowed: true, level: 2, samples: 9, passRate: 0.8 }),
    );
    expect(rec.label).toBe("维持当前等级");
    expect(rec.label).not.toBe("已达上限");
    expect(rec.title).toContain("L2");
  });

  it("still shows an upgrade when the decision targets a higher level", () => {
    // The guard above must key on the level comparison, not on a hardcoded L3.
    const rec = recommendation(
      { ...healthyAgent, autonomyLevel: 2 },
      decision({ allowed: true, level: 3, samples: 8, passRate: 0.75 }),
    );
    expect(rec.label).toBe("可升级");
    expect(rec.tone).toBe("teal");
  });

  it("flags an agent that fails more than it passes, even with a permissive decision", () => {
    // The command layer may still be computing; the audit record already says
    // this agent is a liability, so the page must not stay silent about it.
    const rec = recommendation(
      { ...healthyAgent, failCount: 7, successCount: 3 },
      decision({ allowed: true, samples: 10, passRate: 0.3 }),
    );
    expect(rec.label).toBe("考虑退休");
    expect(rec.tone).toBe("danger");
  });

  it("does not call an even split a liability", () => {
    const rec = recommendation(
      { ...healthyAgent, failCount: 5, successCount: 5 },
      decision({ allowed: false, code: "insufficient_samples" }),
    );
    expect(rec.label).not.toBe("考虑退休");
  });

  it("always returns a label and a title for every branch", () => {
    const branches: Array<[Parameters<typeof recommendation>[0], AutonomyDecision | undefined]> = [
      [healthyAgent, undefined],
      [healthyAgent, decision({ allowed: true })],
      [healthyAgent, decision({ allowed: false, code: "paused" })],
      [{ ...healthyAgent, failCount: 9 }, undefined],
      [{ ...healthyAgent, role: "apprentice", lifecycleStage: "shadowing" }, undefined],
    ];
    for (const [agent, verdict] of branches) {
      const rec = recommendation(agent, verdict);
      expect(rec.label.trim()).not.toBe("");
      expect(rec.title.trim()).not.toBe("");
      expect(["teal", "accent", "danger", "neutral"]).toContain(rec.tone);
    }
  });
});

describe("dissent and open-task vocabulary", () => {
  it("uses a word for every dissent state", () => {
    for (const state of ["pending", "vindicated", "invalidated"]) {
      expect(DISSENT_STATUS[state].label).not.toBe("");
    }
  });

  it("does not colour a pending dissent as success or failure", () => {
    expect(DISSENT_STATUS.pending.tone).toBe("accent");
    expect(DISSENT_STATUS.vindicated.tone).toBe("teal");
    expect(DISSENT_STATUS.invalidated.tone).toBe("neutral");
  });

  it("keeps a rejected task in the open set so it can be fixed", () => {
    expect(OPEN_TASK_STATUS.has("rejected")).toBe(true);
    expect(OPEN_TASK_STATUS.has("awaiting_approval")).toBe(true);
    expect(OPEN_TASK_STATUS.has("running")).toBe(true);
  });

  it("drops finished and failed tasks out of next week's goal", () => {
    for (const status of ["done", "accepted", "failed", "cancelled"] as const) {
      expect(OPEN_TASK_STATUS.has(status), status).toBe(false);
    }
  });

  it("is typed with the TaskStatus union, so a typo is a build error", () => {
    // A plain `Set<string>` accepts "planed" and then silently drops every
    // planned task out of next week's goal — the page just says it found
    // nothing. Binding the set to `TaskStatus` moves that failure to `tsc`.
    const open: ReadonlySet<TaskStatus> = OPEN_TASK_STATUS;
    const expected: TaskStatus[] = [
      "planned",
      "assigned",
      "awaiting_approval",
      "approved",
      "suggested",
      "running",
      "submitted",
      "auditing",
      "rejected",
    ];
    expect([...open].sort()).toEqual([...expected].sort());
  });

  it("keeps failed out of review while Today keeps it in", () => {
    // Deliberate divergence, documented at `src/lib/presentation/review-view.ts`
    // near the set: Today had rather surface a failed task for a decision, but
    // next week's single goal must not be something already given up on.
    expect(OPEN_TASK_STATUS.has("failed")).toBe(false);
  });
});

describe("an empty list and an empty page are different things", () => {
  // Pagination only clamps the offset at 0 (`review.ts:28-29`); it never folds a
  // stale offset back inside `total`. So "no rows on this page" happens for two
  // unrelated reasons, and the card said "本周没有产生新洞察" for both — while its
  // own footer printed 共 5.
  it("calls a genuinely empty list empty", () => {
    expect(listPageState(0, 0)).toBe("empty");
  });

  it("does not call a page past the end an empty list", () => {
    expect(listPageState(5, 0)).toBe("out-of-range");
  });

  it("is normal when the page actually carries rows", () => {
    expect(listPageState(5, 2)).toBe("ok");
    expect(listPageState(1, 1)).toBe("ok");
  });
});

describe("picking next week's single goal", () => {
  const task = (
    id: string,
    overrides: Partial<{
      status: TaskStatus;
      priority: number;
      dueAt: string | null;
    }> = {},
  ) => ({
    id,
    status: "planned" as TaskStatus,
    priority: 2,
    dueAt: null as string | null,
    ...overrides,
  });

  it("puts a task with no deadline last, not first", () => {
    // "".localeCompare("2026-01-05") sorts the blank first, which is how a task
    // with no deadline used to win a race it was not in. The copy promises the
    // goal comes from priority and deadline; an unbounded task has neither.
    const picked = pickFocusTask([
      task("no-due", { dueAt: null }),
      task("due", { dueAt: "2026-01-05" }),
    ]);
    expect(picked?.id).toBe("due");
  });

  it("keeps priority above the deadline", () => {
    const picked = pickFocusTask([
      task("urgent", { priority: 3, dueAt: "2026-03-01" }),
      task("sooner", { priority: 1, dueAt: "2026-01-05" }),
    ]);
    expect(picked?.id).toBe("urgent");
  });

  it("prefers the earlier deadline at equal priority", () => {
    const picked = pickFocusTask([
      task("later", { dueAt: "2026-02-01" }),
      task("earlier", { dueAt: "2026-01-05" }),
    ]);
    expect(picked?.id).toBe("earlier");
  });

  it("leaves finished work out of next week's goal", () => {
    const picked = pickFocusTask([
      task("finished", { status: "accepted", priority: 9 }),
      task("open", { status: "running", priority: 1 }),
    ]);
    expect(picked?.id).toBe("open");
  });

  it("returns nothing when no task is open", () => {
    expect(
      pickFocusTask([task("a", { status: "accepted" }), task("b", { status: "failed" })]),
    ).toBeUndefined();
  });

  it("does not mutate the array it was handed", () => {
    const tasks = [task("a", { priority: 1 }), task("b", { priority: 3 })];
    pickFocusTask(tasks);
    expect(tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });
});