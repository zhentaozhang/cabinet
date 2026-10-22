import { revalidatePath } from "next/cache";
import { createCouncil } from "@/lib/engine";
import { handleMutation } from "@/lib/api/mutation";
import { councilCreateSchema } from "@/lib/validation/schemas";
import { parseBody } from "@/lib/validation/parse";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: "councils.create",
    body,
    handler: async (userId) => {
      const input = parseBody(councilCreateSchema, body);
      const council = await createCouncil(input, userId);
      revalidatePath("/");
      revalidatePath("/council");
      return { status: 200, body: { ok: true, council } };
    },
  });
}
