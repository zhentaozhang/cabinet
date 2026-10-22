import { revalidatePath } from "next/cache";
import { regenerateBrief } from "@/lib/engine";
import { handleMutation } from "@/lib/api/mutation";

export async function POST(req: Request) {
  return handleMutation({
    request: req,
    endpoint: "brief.regenerate",
    handler: async (userId) => {
      const brief = await regenerateBrief(userId);
      revalidatePath("/");
      return { status: 200, body: { ok: true, brief } };
    },
  });
}
