import { and, eq } from "drizzle-orm";

import { handleQueryWithRequest } from "@/lib/api/read";
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import {
  explainRunPolicy,
  type PolicyExplanation,
} from "@/lib/domain/policy-explain";
import { loadRunContext } from "@/server/services/commands/tasks/run-context";

export type PolicyPreview = Pick<
  PolicyExplanation,
  "effect" | "rule" | "reason" | "missing"
>;

/**
 * 预演一次「点运行会发生什么」。
 *
 * 取数与真实执行共用同一个 loader（src/server/services/commands/tasks/run-context.ts），
 * 这里不再复刻一遍字段。预演的全部价值建立在「和真实运行同一份输入」上，
 * 而两份手写的取数代码迟早会分叉 —— 从前这里靠一句注释提醒自己同步。
 * 判定本身仍由 explainRunPolicy → decideRun 给出。
 *
 * 两处刻意的差异：
 * - `provision: false`：GET 不能顺手插出一个周预算行。
 * - 不处理重试：预演的是「现在点运行」，重试语义只发生在 run.ts 里。
 */
async function loadPolicyPreview(
  taskId: string,
  userId: string,
): Promise<PolicyPreview | null> {
  // 归属条件写在 where 里而不是查回来再比对：别人的任务和不存在的任务
  // 从这里出去是同一个 null，路由层统一回 404，不能用来探测别人的任务 id。
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
  if (!task) return null;

  // 没有执行者就没有可预演的判定：run.ts 会以同一个 409 拒绝执行，
  // 预演跟着报同一件事，比伪装成「放行」诚实。
  const context = await loadRunContext(task, { provision: false });
  const explained = explainRunPolicy(context.policyInput);

  return {
    effect: explained.effect,
    rule: explained.rule,
    reason: explained.reason,
    missing: explained.missing,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleQueryWithRequest(request, (userId) =>
    loadPolicyPreview(id, userId),
  );
}
