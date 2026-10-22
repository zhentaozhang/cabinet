import { revalidatePath } from "next/cache";
import { handleMutation } from "@/lib/api/mutation";
import { parseBody } from "@/lib/validation/parse";
import { taskSubmitSchema } from "@/lib/validation/schemas";
import { submitTaskArtifact } from "@/server/services/commands/tasks/submit";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: `tasks.submit:${id}`,
    body,
    handler: async (userId) => {
      const input = parseBody(taskSubmitSchema, body);
      const result = await submitTaskArtifact({ ...input, taskId: id }, userId);
      revalidatePath("/");
      revalidatePath("/review");
      revalidatePath(`/tasks/${id}`);
      return { status: 200, body: { ok: true, ...result } };
    },
  });
}
