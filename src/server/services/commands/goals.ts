import { and, eq } from "drizzle-orm";

import { goalActionLabel, goalStatusLabel } from "@/contracts/labels";
import type { GoalTransitionAction } from "@/contracts/goals";
import { db } from "@/lib/db";
import { goals } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { logAuditTx } from "@/lib/audit";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/lib/domain/errors";
import {
  GOAL_ACTION_TARGET,
  allowedGoalActions,
  canRunGoalAction,
} from "@/lib/domain/state";

export async function createGoal(
  input: {
    title: string;
    why: string;
    target: string;
    horizon: string;
    domain: string;
  },
  userId: string,
) {
  const title = input.title.trim();
  const why = input.why.trim();
  const target = input.target.trim();
  const horizon = input.horizon.trim();
  const domain = input.domain.trim();
  if (!title || !why || !target || !horizon || !domain) {
    throw new ValidationError("All goal fields are required.");
  }

  const id = newId("goal");
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(goals)
      .values({
        id,
        userId: userId,
        domain,
        title,
        why,
        target,
        horizon,
        status: "active",
        progress: 0,
      })
      .returning();

    await logAuditTx(tx, {
      userId: userId,
      actor: "user",
      action: "goal.create",
      target: id,
      before: null,
      after: { title, domain, horizon },
    });

    return created;
  });
}

/**
 * 非法迁移的中文说明。
 *
 * 用户点错动作是使用错误（400），不是并发冲突（409）——把两者混成一个码，
 * 前端就只能一边提示"刷新重试"一边提示"这个动作现在不能做"。
 * 消息里必须带上"现在还能做什么"：只说"不能恢复"，用户唯一能做的就是反复试。
 */
function illegalTransitionMessage(
  from: string,
  action: GoalTransitionAction,
): string {
  const head = `目标当前状态是「${goalStatusLabel(from)}」，不能${goalActionLabel(action)}。`;
  const allowed = allowedGoalActions(from);
  if (allowed.length === 0) {
    return head;
  }
  const next = allowed
    .map(
      (item) =>
        `${goalActionLabel(item)}（→ ${goalStatusLabel(GOAL_ACTION_TARGET[item])}）`,
    )
    .join("、");
  return `${head}之后只能：${next}。`;
}

/**
 * 推进目标的生命周期：暂停 / 恢复 / 完成 / 归档 / 重新打开。
 *
 * 顺序是"读当前状态 → 判定动作 → 带着旧状态写回"。第三步的条件
 * `status = from` 不能省：两个并发请求都会先读到 active，若写回不带条件，
 * 两次都成功，审计里就有两行"改成 paused"，其中一行描述的状态从未存在过。
 * 条件写回之后，后到的那次命中零行，如实变成 409 交给调用方重试。
 *
 * 完成不动 progress：进度是验收过的任务算出来的，按一下"完成"就写 100 等于
 * 给用户看一个没发生过的数字。想变成 100% 只能去推进任务。
 */
export async function transitionGoal(input: {
  goalId: string;
  userId: string;
  action: GoalTransitionAction;
}) {
  const [goal] = await db
    .select()
    .from(goals)
    .where(and(eq(goals.id, input.goalId), eq(goals.userId, input.userId)));

  // 不存在与"不属于你"回答同一个 404：区分开来等于让别人探测目标 id 是否存在。
  if (!goal) {
    throw new NotFoundError("Goal not found.");
  }

  const from = goal.status;
  if (!canRunGoalAction(input.action, from)) {
    throw new ValidationError(illegalTransitionMessage(from, input.action));
  }
  const to = GOAL_ACTION_TARGET[input.action];

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(goals)
      .set({ status: to })
      .where(
        and(
          eq(goals.id, goal.id),
          eq(goals.userId, input.userId),
          eq(goals.status, from),
        ),
      )
      .returning();

    if (!updated) {
      throw new ConflictError("Goal state changed; retry.");
    }

    await logAuditTx(tx, {
      userId: input.userId,
      actor: "user",
      action: "goal.status",
      target: goal.id,
      before: { status: from },
      after: { status: to },
    });

    return updated;
  });
}
