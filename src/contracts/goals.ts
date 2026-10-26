import { z } from "zod";

/**
 * 目标的生命周期状态。
 *
 * 值只有这四个：进行中、暂停、完成、归档。没有"放弃"——放弃是删除意图，
 * 而这里所有结论都必须留在数据里能被复盘，所以目标只能向前收敛，不能消失。
 */
export const GOAL_STATUSES = [
  "active",
  "paused",
  "completed",
  "archived",
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const goalStatusSchema = z.enum(GOAL_STATUSES);

/**
 * 人能对目标发起的动作，每个动作落到一个确定的下一状态（见
 * src/lib/domain/state.ts 的动作表）。
 *
 * 动作是独立的词而不是"直接写状态"：写状态意味着客户端自己判断合法性，
 * 于是"跳过完成直接归档"这类迁移会从某个忘记判断的调用点漏进来。
 */
export const GOAL_TRANSITION_ACTIONS = [
  "pause",
  "resume",
  "complete",
  "archive",
  "reopen",
] as const;

export type GoalTransitionAction = (typeof GOAL_TRANSITION_ACTIONS)[number];

export const goalTransitionActionSchema = z.enum(GOAL_TRANSITION_ACTIONS);

/**
 * 请求体契约放在 contracts 而不是 src/lib/validation/schemas.ts：路由只需要
 * 认识 contracts 就够校验一个目标动作，业务校验文件不必成为所有端点的漏斗。
 */
export const goalTransitionSchema = z.object({
  action: goalTransitionActionSchema,
});

export type GoalTransitionInput = z.infer<typeof goalTransitionSchema>;


/**
 * 目标状态图：进行中 ⇄ 已暂停，两者都能标记完成，完成只能归档，归档可以
 * 重新打开。
 *
 * completed 没有回到 active 的边，这是有意的：完成是一次事实声明，静默退回
 * 会把"完成过"这件事从数据里抹掉。要接着做，得先归档再重新打开——两步，每步
 * 都留审计行，想绕过就得先留下痕迹。
 */
export const GOAL_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  active: ["paused", "completed"],
  paused: ["active", "completed"],
  completed: ["archived"],
  archived: ["active"],
};

/** 动作 → 落点状态。它只回答"落到哪"，合法性由下面的动作表判定。 */
export const GOAL_ACTION_TARGET: Record<GoalTransitionAction, GoalStatus> = {
  pause: "paused",
  resume: "active",
  complete: "completed",
  archive: "archived",
  reopen: "active",
};

/**
 * 每个动作允许从哪些状态发起。
 *
 * 不能只看目标状态：resume 和 reopen 都落在 active，光比目标的话"重新打开
 * 一个暂停的目标"也合法，于是同一个结果有两个名字、审计会记错动作。分开写
 * 之后按钮的可用性和日志的用词都与状态图严格对齐。
 */
export const GOAL_ACTION_EDGES: Record<
  GoalTransitionAction,
  readonly GoalStatus[]
> = {
  pause: ["active"],
  resume: ["paused"],
  complete: ["active", "paused"],
  archive: ["completed"],
  reopen: ["archived"],
};

/** 这个动作当前能不能从这个状态发起（动作表，不是状态图）。 */
export function canRunGoalAction(
  action: GoalTransitionAction,
  from: string,
): boolean {
  return GOAL_ACTION_EDGES[action].includes(from as GoalStatus);
}

/**
 * 从当前状态出发还能做哪些动作。
 *
 * 非法迁移的错误消息要用它回答"那我该点哪个"；只报"不能暂停"的话，用户只能
 * 挨个试，试错的每个请求都会写一条失败日志。
 */
export function allowedGoalActions(from: string): GoalTransitionAction[] {
  return GOAL_TRANSITION_ACTIONS.filter((action) =>
    canRunGoalAction(action, from),
  );
}

