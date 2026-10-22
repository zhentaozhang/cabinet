import { revalidatePath } from "next/cache";
import { runReflection } from "@/lib/engine";
import { handleMutation } from "@/lib/api/mutation";

export async function POST(req: Request) {
  return handleMutation({
    request: req,
    endpoint: "reflection.run",
    handler: async (userId) => {
      const insight = await runReflection(userId);
      revalidatePath("/review");
      revalidatePath("/");
      return { status: 200, body: { ok: true, insightId: insight.id } };
    },
  });
}
