import { revalidatePath } from "next/cache";
import { runTask } from "@/lib/engine";
import { handleMutation } from "@/lib/api/mutation";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: `tasks.run:${id}`,
    body,
    handler: async (userId) => {
      const result = await runTask(id, userId);
      revalidatePath("/");
      revalidatePath("/cabinet");
      revalidatePath("/review");
      revalidatePath(`/tasks/${id}`);
      return {
        status: result.requiresApproval ? 202 : 200,
        body: { ok: true, ...result },
      };
    },
  });
}
