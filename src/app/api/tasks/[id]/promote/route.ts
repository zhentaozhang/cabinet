import { revalidatePath } from "next/cache";
import { promoteSuggestion } from "@/lib/engine";
import { handleMutation } from "@/lib/api/mutation";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: `tasks.promote:${id}`,
    body,
    handler: async (userId) => {
      await promoteSuggestion(id, userId);
      revalidatePath("/");
      revalidatePath(`/tasks/${id}`);
      return { status: 200, body: { ok: true } };
    },
  });
}
