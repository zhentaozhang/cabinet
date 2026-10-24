import { revalidatePath } from "next/cache";
import { graduateApprentice } from "@/server/services/commands/apprentice";
import { handleMutation } from "@/lib/api/mutation";

export async function POST(req: Request) {
  return handleMutation({
    request: req,
    endpoint: "apprentice.graduate",
    handler: async (userId) => {
      const result = await graduateApprentice(userId);
      revalidatePath("/cabinet");
      revalidatePath("/review");
      return { status: 200, body: { ok: true, ...result } };
    },
  });
}
