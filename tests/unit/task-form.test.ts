import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { assigneeBlockReason } from "@/lib/domain/policy";
import {
  assignableAgents,
  assigneeBlockLabel,
  AUDITOR_CONFLICT_MESSAGE,
  COST_FORMAT_MESSAGE,
  planAdvancedFocus,
  validateTaskDraft,
  yuanToCents,
  type AgentChoice,
  type TaskDraft,
} from "@/lib/presentation/task-form";
describe("who the task form offers as the assignee", () => {
  const agent = (over: Partial<AgentChoice> = {}): AgentChoice => ({
    id: "ag_coach",
    name: "Coach",
    role: "coach",
    status: "active",
    lifecycleStage: "active",
    ...over,
  });

  it("drops the Agents that could never run the task", () => {
    // `decideRun` refuses a non-active status or lifecycleStage before any run
    // row exists, so a task handed to one of these would sit in planned forever.
    const roster = [
      agent(),
      agent({ id: "ag_trainee", lifecycleStage: "shadowing" }),
      agent({ id: "ag_gone", status: "retired", lifecycleStage: "retired" }),
      agent({ id: "ag_paused", status: "paused" }),
    ];
    expect(assignableAgents(roster).map((row) => row.id)).toEqual([
      "ag_coach",
      "ag_paused",
    ]);
  });

  it("labels why an unavailable Agent cannot take work", () => {
    expect(assigneeBlockLabel(agent())).toBeNull();
    // Paused is one click from active: queueing work for it still makes sense.
    expect(assigneeBlockLabel(agent({ status: "paused" }))).toBeNull();
    expect(assigneeBlockLabel(agent({ lifecycleStage: "shadowing" }))).toBe(
      "未转正，不能接单",
    );
    expect(
      assigneeBlockLabel(agent({ status: "retired", lifecycleStage: "retired" })),
    ).toBe("已退休，不能接单");
  });

  it("reads status and lifecycle separately", () => {
    // Retired wins over a stale lifecycleStage; a trainee is a lifecycle fact,
    // and probation is only a duty state.
    expect(assigneeBlockReason({ status: "retired", lifecycleStage: "active" })).toBe(
      "retired",
    );
    expect(
      assigneeBlockReason({ status: "active", lifecycleStage: "practice_passed" }),
    ).toBe("trainee");
    expect(assigneeBlockReason({ status: "probation", lifecycleStage: "active" })).toBe(
      "off_duty",
    );
    expect(assigneeBlockReason({ status: "active", lifecycleStage: "active" })).toBeNull();
  });

  it("feeds the dropdown and the preview from the same rule", () => {
    const form = readFileSync(
      join(process.cwd(), "src/components/actions/quick-create.tsx"),
      "utf8",
    );
    expect(form).toContain("const assignable = assignableAgents(agents);");
    expect(form).toContain("const blocked = assigneeBlockLabel(agent);");
    expect(form).toContain("没有可以接单的 Agent");

    // The form cannot filter what the page never sends.
    const today = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");
    expect(today).toContain("status: agent.status,");
    expect(today).toContain("lifecycleStage: agent.lifecycleStage,");
  });
});

function draft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    title: "整理竞品定价",
    acceptanceCriteria: "列出 5 家竞品并标注价格来源",
    description: "只看公开定价页",
    auditorId: "agt_auditor",
    assigneeId: "agt_atlas",
    actionType: "internal",
    costYuan: "",
    ...overrides,
  };
}

describe("validateTaskDraft", () => {
  it("accepts a filled-in draft", () => {
    const result = validateTaskDraft(draft());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual({});
    expect(result.focus).toBeNull();
  });

  it("requires the three core fields", () => {
    const result = validateTaskDraft(
      draft({ title: "  ", acceptanceCriteria: "", description: "" }),
    );
    expect(result.errors.title).toBeDefined();
    expect(result.errors.acceptanceCriteria).toBeDefined();
    expect(result.errors.description).toBeDefined();
    expect(result.valid).toBe(false);
  });

  it("sends focus to the first problem in reading order", () => {
    // Not the last problem found: an unordered object plus an if/else chain
    // used to make the destination depend on how the branches were written.
    expect(validateTaskDraft(draft({ title: "", description: "" })).focus).toBe(
      "title",
    );
    expect(
      validateTaskDraft(draft({ acceptanceCriteria: "", description: "" })).focus,
    ).toBe("acceptanceCriteria");
    expect(validateTaskDraft(draft({ description: "" })).focus).toBe(
      "description",
    );
  });

  it("rejects an auditor who is also the assignee", () => {
    const result = validateTaskDraft(
      draft({ assigneeId: "agt_atlas", auditorId: "agt_atlas" }),
    );
    expect(result.errors.auditor).toBe(AUDITOR_CONFLICT_MESSAGE);
    expect(result.focus).toBe("auditor");
  });

  it("rejects a missing auditor", () => {
    const result = validateTaskDraft(draft({ auditorId: "" }));
    expect(result.errors.auditor).toBe("请指定验收者");
  });

  it("only demands an amount for spend actions", () => {
    expect(validateTaskDraft(draft({ actionType: "internal" })).valid).toBe(true);
    expect(validateTaskDraft(draft({ actionType: "external" })).valid).toBe(true);

    const missing = validateTaskDraft(draft({ actionType: "spend" }));
    expect(missing.errors.cost).toBe("支出任务金额需大于 0 元");
    expect(missing.focus).toBe("cost");
  });

  it("rejects zero, negative and non-numeric spend amounts", () => {
    for (const costYuan of ["0", "-5", "abc", "  "]) {
      const result = validateTaskDraft(draft({ actionType: "spend", costYuan }));
      expect(result.errors.cost, costYuan).toBeDefined();
      expect(result.valid, costYuan).toBe(false);
    }
  });

  it("accepts a positive spend amount", () => {
    const result = validateTaskDraft(
      draft({ actionType: "spend", costYuan: "12.5" }),
    );
    expect(result.errors.cost).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it("rejects an amount carrying a unit suffix instead of charging its digits", () => {
    // parseFloat("12元") === 12, so typing 「12元」 used to be silently
    // accepted and charged 12 元. The format has to fail loudly instead.
    const result = validateTaskDraft(
      draft({ actionType: "spend", costYuan: "12元" }),
    );
    expect(result.errors.cost).toBe(COST_FORMAT_MESSAGE);
    expect(result.valid).toBe(false);
  });

  it("keeps the amount wording for blank and zero amounts", () => {
    // Those are well-formed but unusable values; they must not be reported as
    // a formatting problem.
    for (const costYuan of ["", "   ", "0", "0.00"]) {
      const result = validateTaskDraft(draft({ actionType: "spend", costYuan }));
      expect(result.errors.cost, costYuan).toBeDefined();
      expect(result.errors.cost, costYuan).not.toBe(COST_FORMAT_MESSAGE);
    }
  });

  it("reports the auditor conflict through the shared message constant", () => {
    // The quick-create form compares `errors.auditor` against this constant to
    // decide whether a stale error can be cleared, so the two must be the same
    // string — not two literals that happen to match today.
    const result = validateTaskDraft(
      draft({ assigneeId: "agt_atlas", auditorId: "agt_atlas" }),
    );
    expect(result.errors.auditor).toBe(AUDITOR_CONFLICT_MESSAGE);
    expect(AUDITOR_CONFLICT_MESSAGE).toBe("验收者不能是执行者");
  });

  it("prefers the core fields over the advanced ones when both fail", () => {
    // A person should be walked through the visible fields first; jumping into
    // 「更多配置」 while the title is still empty hides the first problem.
    const result = validateTaskDraft(
      draft({ title: "", auditorId: "", actionType: "spend" }),
    );
    expect(result.focus).toBe("title");
    expect(result.errors.auditor).toBeDefined();
    expect(result.errors.cost).toBeDefined();
  });

  it("reports the auditor before the cost when both are in the advanced block", () => {
    const result = validateTaskDraft(
      draft({ auditorId: "", actionType: "spend" }),
    );
    expect(result.focus).toBe("auditor");
  });

  it("does not demand an assignee", () => {
    // Leaving the assignee blank is allowed — the server picks one.
    const result = validateTaskDraft(draft({ assigneeId: "" }));
    expect(result.valid).toBe(true);
  });
});

describe("planAdvancedFocus", () => {
  it("focuses immediately when the block is already open", () => {
    // The regression this guards: a focus effect keyed on `advancedOpen` never
    // re-runs when `true` is set to `true`, so someone who had already expanded
    // 「更多配置」 was shown an error with focus left on the submit button.
    expect(planAdvancedFocus("auditor", true)).toEqual({
      kind: "focus-now",
      field: "auditor",
    });
    expect(planAdvancedFocus("cost", true)).toEqual({
      kind: "focus-now",
      field: "cost",
    });
  });

  it("opens first, then focuses, when the block is collapsed", () => {
    // The field does not exist in the DOM while the disclosure is closed, so
    // the focus call has to wait for the open to commit.
    expect(planAdvancedFocus("auditor", false)).toEqual({
      kind: "open-then-focus",
      field: "auditor",
    });
  });

  it("does nothing when the first problem is a visible field", () => {
    expect(planAdvancedFocus(null, false)).toEqual({ kind: "none" });
    expect(planAdvancedFocus(null, true)).toEqual({ kind: "none" });
  });

  it("never reports a plan for a field outside the block", () => {
    // The title is always visible; routing it through the advanced path would
    // open a disclosure the person does not need.
    for (const open of [true, false]) {
      expect(planAdvancedFocus(null, open).kind).toBe("none");
    }
  });
});

describe("yuanToCents", () => {
  it("converts a plain yuan amount to cents", () => {
    expect(yuanToCents("12")).toBe(1200);
    expect(yuanToCents("12.5")).toBe(1250);
    expect(yuanToCents("12.50")).toBe(1250);
    expect(yuanToCents("0.01")).toBe(1);
    // Surrounding whitespace is what a person pastes in; trim it rather than
    // rejecting an otherwise correct number.
    expect(yuanToCents(" 8 ")).toBe(800);
  });

  it("rejects the inputs parseFloat used to swallow", () => {
    // Each of these parsed to a "valid" number before: 12元→12, 12abc→12,
    // 12.5.5→12.5, 1,000→1, 1e3→1000, １２３→123.
    for (const raw of [
      "12元",
      "12abc",
      "12.5.5",
      "1,000",
      "1e3",
      "+",
      "１２３",
    ]) {
      expect(yuanToCents(raw), raw).toBeNull();
    }
  });

  it("rejects signs, exponents and malformed decimals", () => {
    // A leading minus or plus, exponent notation and more than two decimal
    // places must fail instead of being rounded into a charge.
    for (const raw of [
      "-5",
      "-0.01",
      "+8",
      "1.234",
      ".5",
      "12.",
      "0x10",
      "Infinity",
      "NaN",
      "  ",
    ]) {
      expect(yuanToCents(raw), raw).toBeNull();
    }
  });

  it("treats a blank amount as unfilled rather than as zero", () => {
    // An empty box means "no amount entered"; returning 0 would turn a missing
    // value into a real charge of 0 元 and hide the validation error.
    expect(yuanToCents("")).toBeNull();
    expect(yuanToCents("")).not.toBe(0);
    expect(yuanToCents("   ")).not.toBe(0);
  });
});
