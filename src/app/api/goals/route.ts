import { revalidatePath } from "next/cache";
import { createGoal } from "@/lib/engine";
import { handleMutation } from "@/lib/api/mutation";
import { goalCreateSchema } from "@/lib/validation/schemas";
import { parseBody } from "@/lib/validation/parse";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: "goals.create",
    body,
    handler: async (userId) => {
      const input = parseBody(goalCreateSchema, body);
      const goal = await createGoal(input, userId);
      revalidatePath("/");
      revalidatePath("/review");
      return { status: 200, body: { ok: true, goal } };
    },
  });
}
