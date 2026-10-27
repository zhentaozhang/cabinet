import { revalidatePath } from "next/cache";
import { z } from "zod";
import { overrideAudit } from "@/server/services/commands/tasks/override";
import { handleMutation } from "@/lib/api/mutation";
import { parseBody } from "@/lib/validation/parse";

/**
 * 判定理由在这里就限死长度，和命令里的检查同源：
 * 接口先挡住明显不合格的请求（少一次数据库往返），命令层再挡一次，
 * 因为命令行/测试可以绕过 HTTP 直接调命令。
 */
const overrideSchema = z.object({
  decision: z.enum(["accepted", "rejected"]),
  reason: z
    .string()
    .trim()
    .min(5, "判定理由至少 5 个字：请说明你依据什么下这个结论")
    .max(500, "判定理由最多 500 个字"),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: `tasks.override:${id}`,
    // 参与幂等指纹：同一个 Idempotency-Key 带着不同判定不应复用旧结果。
    body,
    handler: async (userId) => {
      const input = parseBody(overrideSchema, body);
      const result = await overrideAudit({
        taskId: id,
        userId,
        decision: input.decision,
        reason: input.reason,
      });
      revalidatePath(`/tasks/${id}`);
      // 审计行是这个入口的产物，/review/audit 直接按 audit_events 渲染。
      revalidatePath("/review/audit");
      // 待判定任务在首页与复核队列上都有自己的计数/入口（today-view、review-view
      // 都把 needs_review 算进去了），判定之后它们不该还停在"待你判定"。
      revalidatePath("/");
      revalidatePath("/review");
      return { status: 200, body: { ok: true, status: result.task.status } };
    },
  });
}
