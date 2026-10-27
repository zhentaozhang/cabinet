import { revalidatePath } from "next/cache";
import { auditTask } from "@/server/services/commands/tasks/audit";
import { handleMutation } from "@/lib/api/mutation";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: `tasks.audit:${id}`,
    body,
    handler: async (userId) => {
      const result = await auditTask(id, userId);
      revalidatePath("/");
      revalidatePath("/cabinet");
      revalidatePath("/review");
      revalidatePath(`/tasks/${id}`);
      return {
        status: 200,
        body: {
          ok: true,
          // decision 是任务写回后的状态（accepted / rejected / needs_review），
          // verdict 是同一结论的三值说法。前端必须按三值分支处理：把
          // needs_review 读成 rejected 会显示"验收结果：驳回"，读成 accepted
          // 会显示"通过"——两边都在替用户下这个结论。
          decision: result.decision,
          verdict: result.verdict,
          reason: result.reason,
          runId: result.runId,
        },
      };
    },
  });
}
