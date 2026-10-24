import { revalidatePath } from "next/cache";
import { decideApproval } from "@/server/services/commands/tasks/approvals";
import { handleMutation } from "@/lib/api/mutation";
import { approvalDecisionSchema } from "@/lib/validation/schemas";
import { parseBody } from "@/lib/validation/parse";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: `approvals.decide:${id}`,
    body,
    handler: async (userId) => {
      const input = parseBody(approvalDecisionSchema, body);
      await decideApproval(id, input.decision, input.reason, userId, {
        remember: input.remember,
      });
      revalidatePath("/");
      revalidatePath("/review");
      // The approval card is rendered on the task page too, so a decision taken
      // there must invalidate that route as well. Without it, navigating back
      // to the task (hard navigation, or another tab) shows the pre-decision
      // "待审批" card while the API has already moved the task on.
      // Dynamic segment: Next requires the route pattern plus `type`.
      revalidatePath("/tasks/[id]", "page");
      return { status: 200, body: { ok: true } };
    },
  });
}
