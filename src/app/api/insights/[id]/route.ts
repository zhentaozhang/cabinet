import { revalidatePath } from "next/cache";
import { applyInsight } from "@/server/services/engine";
import { handleMutation } from "@/lib/api/mutation";
import { insightActionSchema } from "@/lib/validation/schemas";
import { parseBody } from "@/lib/validation/parse";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: `insights.apply:${id}`,
    body,
    handler: async (userId) => {
      const input = parseBody(insightActionSchema, body);
      await applyInsight(id, input.action, userId);
      revalidatePath("/");
      revalidatePath("/review");
      revalidatePath("/memory");
      return { status: 200, body: { ok: true } };
    },
  });
}
