import { revalidatePath } from "next/cache";
import { cancelTask } from "@/server/services/commands/tasks/cancel";
import { handleMutation } from "@/lib/api/mutation";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  return handleMutation({
    request: req,
    endpoint: `tasks.cancel:${id}`,
    handler: async (userId) => {
      const result = await cancelTask(id, userId, body.reason ?? "");
      revalidatePath("/");
      revalidatePath("/review");
      revalidatePath(`/tasks/${id}`);
      return { status: 200, body: { ok: true, status: result.status } };
    },
  });
}
