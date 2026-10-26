import { describe, expect, it } from "vitest";

import {
  goalTransitionActionSchema,
  goalTransitionSchema,
} from "@/contracts";
import {
  GOAL_ACTION_EDGES,
  GOAL_ACTION_TARGET,
  GOAL_TRANSITIONS,
  allowedGoalActions,
  assertTransition,
  canRunGoalAction,
  canTransition,
  isTerminal,
} from "@/lib/domain/state";
import { GOAL_TRANSITION_ACTIONS, type GoalStatus } from "@/contracts/goals";
import { ConflictError } from "@/lib/domain/errors";

/**
 * 目标生命周期：进行中 ⇄ 已暂停，两种都能标记完成，完成只能归档，
 * 归档可以重新打开。
 *
 * 这张表是唯一事实来源，"哪些动作现在能做"由它算出来，所以非法迁移既有
 * 明确的判定，也有可读的提示。
 */
describe("goal state machine", () => {
  it.each([
    ["active", "paused"],
    ["paused", "active"],
    ["active", "completed"],
    ["paused", "completed"],
    ["completed", "archived"],
    ["archived", "active"],
  ])("allows %s → %s", (from, to) => {
    expect(canTransition("goal", from, to)).toBe(true);
  });

  it.each([
    // 完成是一次事实声明：不能退回进行中，否则"完成过"这件事在数据里消失。
    ["completed", "active"],
    ["completed", "paused"],
    // 归档是进一步收敛，不能借此绕过 completed。
    ["active", "archived"],
    ["paused", "archived"],
    // 归档后要回来只能先重新打开，不能直接跳到暂停或完成。
    ["archived", "paused"],
    ["archived", "completed"],
  ])("rejects %s → %s", (from, to) => {
    expect(canTransition("goal", from, to)).toBe(false);
  });

  it("rejects transitions from an unknown status", () => {
    expect(canTransition("goal", "abandoned", "active")).toBe(false);
  });

  it("throws ConflictError from the shared helper for illegal edges", () => {
    expect(() => assertTransition("goal", "completed", "active")).toThrow(
      ConflictError,
    );
    expect(() => assertTransition("goal", "archived", "paused")).toThrow(
      ConflictError,
    );
  });

  it("treats archived as non-terminal, because a filed goal can be picked up again", () => {
    expect(isTerminal("goal", "archived")).toBe(false);
    expect(GOAL_TRANSITIONS.archived).toEqual(["active"]);
  });

  it("has no terminal goal statuses yet", () => {
    // 记下这个事实而不是留白：如果哪天加了一个真正的终点，这条会失败并迫使
    // 作者想清楚"归档 vs 终点"的区别。
    const terminal = (Object.keys(GOAL_TRANSITIONS) as Array<
      keyof typeof GOAL_TRANSITIONS
    >).filter((status) => GOAL_TRANSITIONS[status].length === 0);
    expect(terminal).toEqual([]);
  });
});

describe("goal lifecycle actions", () => {
  it.each([
    ["pause", "paused"],
    ["resume", "active"],
    ["complete", "completed"],
    ["archive", "archived"],
    ["reopen", "active"],
  ] as const)("maps %s to %s", (action, status) => {
    expect(GOAL_ACTION_TARGET[action]).toBe(status);
  });

  it("keeps every action edge present in the transition table", () => {
    // 动作表与状态图是同一件事的两种读法。任何一边单独改动而另一边没跟，
    // 就会出现"按钮可点但状态写不回去"或者反之，这条断言负责发现它。
    for (const [action, froms] of Object.entries(GOAL_ACTION_EDGES)) {
      for (const from of froms) {
        expect(
          canTransition(
            "goal",
            from,
            GOAL_ACTION_TARGET[action as keyof typeof GOAL_ACTION_TARGET],
          ),
          action + " from " + from,
        ).toBe(true);
      }
    }
  });

  it("covers every edge in the table with at least one action", () => {
    for (const from of Object.keys(GOAL_TRANSITIONS) as GoalStatus[]) {
      for (const to of GOAL_TRANSITIONS[from]) {
        const actions = GOAL_TRANSITION_ACTIONS.filter(
          (action) =>
            GOAL_ACTION_TARGET[action] === to && canRunGoalAction(action, from),
        );
        expect(actions, from + " → " + to).not.toHaveLength(0);
      }
    }
  });

  it("does not let reopen pretend to resume a paused goal", () => {
    // resume 和 reopen 都落在 active。只看目标状态的话，reopen 在 paused 上
    // 也"合法"，于是用户可以用错误的名字做对的事，审计也记错动作。
    expect(canRunGoalAction("reopen", "paused")).toBe(false);
    expect(canRunGoalAction("resume", "archived")).toBe(false);
    expect(allowedGoalActions("paused")).toEqual(["resume", "complete"]);
    expect(allowedGoalActions("archived")).toEqual(["reopen"]);
    expect(allowedGoalActions("completed")).toEqual(["archive"]);
    expect(allowedGoalActions("active")).toEqual(["pause", "complete"]);
  });

  it("leaves no status without an action, so nothing gets stuck", () => {
    for (const from of Object.keys(GOAL_TRANSITIONS) as GoalStatus[]) {
      expect(allowedGoalActions(from), from).not.toHaveLength(0);
    }
  });

  it("exposes no action that no status can start from", () => {
    // 一个"存在但没有任何状态能走到"的动作是纯装饰：它在 API 里可调用，
    // 却永远返回非法迁移。这条断言让这种死动作在加进来时就失败。
    const dead = Object.entries(GOAL_ACTION_TARGET).filter(
      ([, target]) =>
        !Object.keys(GOAL_TRANSITIONS).some((from) =>
          GOAL_TRANSITIONS[from as keyof typeof GOAL_TRANSITIONS].includes(target),
        ),
    );
    expect(dead).toEqual([]);
  });
});

describe("goal transition request body", () => {
  it.each(["pause", "resume", "complete", "archive", "reopen"] as const)(
    "accepts %s",
    (action) => {
      expect(goalTransitionSchema.safeParse({ action }).success).toBe(true);
      expect(goalTransitionActionSchema.safeParse(action).success).toBe(true);
    },
  );

  it.each([
    ["delete"],
    [""],
    ["PAUSE"],
    [undefined],
  ])("rejects %s", (action) => {
    expect(goalTransitionSchema.safeParse({ action }).success).toBe(false);
  });

  it("rejects a body without an action", () => {
    expect(goalTransitionSchema.safeParse({}).success).toBe(false);
    expect(goalTransitionSchema.safeParse(null).success).toBe(false);
  });
});
