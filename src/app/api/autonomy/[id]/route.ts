import { revalidatePath } from "next/cache";
import { setAutonomy } from "@/lib/engine";
import { handleMutation } from "@/lib/api/mutation";
import { autonomySchema } from "@/lib/validation/schemas";
import { parseBody } from "@/lib/validation/parse";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: `autonomy.change:${id}`,
    body,
    handler: async (userId) => {
      const input = parseBody(autonomySchema, body);
      const result = await setAutonomy(id, input.level, userId);
      revalidatePath("/cabinet");
      revalidatePath(`/cabinet/${id}`);
      revalidatePath("/");
      return { status: 200, body: { ok: true, ...result } };
    },
  });
}
