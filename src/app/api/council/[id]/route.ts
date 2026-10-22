import { revalidatePath } from "next/cache";
import { decideCouncil } from "@/lib/engine";
import { handleMutation } from "@/lib/api/mutation";
import { councilDecisionSchema } from "@/lib/validation/schemas";
import { parseBody } from "@/lib/validation/parse";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: `councils.decide:${id}`,
    body,
    handler: async (userId) => {
      const input = parseBody(councilDecisionSchema, body);
      await decideCouncil(id, input.decision, input.note, userId);
      revalidatePath("/");
      revalidatePath("/council");
      revalidatePath("/review");
      return { status: 200, body: { ok: true } };
    },
  });
}
