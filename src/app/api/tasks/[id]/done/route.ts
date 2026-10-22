import { revalidatePath } from "next/cache";
import { markTaskDone } from "@/server/services/commands/tasks/done";
import { handleMutation } from "@/lib/api/mutation";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleMutation({
    request: req,
    endpoint: `tasks.done:${id}`,
    handler: async (userId) => {
      await markTaskDone(id, userId);
      revalidatePath("/");
      revalidatePath("/review");
      revalidatePath(`/tasks/${id}`);
      return { status: 200, body: { ok: true } };
    },
  });
}
