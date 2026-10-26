import { revalidatePath } from "next/cache";

import { goalTransitionSchema } from "@/contracts/goals";
import { handleMutation } from "@/lib/api/mutation";
import { parseBody } from "@/lib/validation/parse";
import { toGoalDto } from "@/server/mappers";
import { transitionGoal } from "@/server/services/engine";

/**
 * 推进一个目标的生命周期。
 *
 * 动作在请求体里而不是 URL 上（POST /api/goals/[id] + {action}）：一个动作
 * 只落一个确定的状态，客户端不需要也不应该自己算"pause 之后是暂停还是归档"。
 * 合法性仍由服务端状态表判定，路由只负责把请求变成一次命令。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: `goals.transition:${id}`,
    body,
    handler: async (userId) => {
      const input = parseBody(goalTransitionSchema, body);
      const goal = await transitionGoal({
        goalId: id,
        userId,
        action: input.action,
      });
      revalidatePath("/");
      return { status: 200, body: { ok: true, goal: toGoalDto(goal) } };
    },
  });
}
