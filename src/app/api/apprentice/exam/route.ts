import { revalidatePath } from "next/cache";
import { runApprenticeExam } from "@/server/services/engine";
import { handleMutation } from "@/lib/api/mutation";

export async function POST(req: Request) {
  return handleMutation({
    request: req,
    endpoint: "apprentice.exam",
    handler: async (userId) => {
      const result = await runApprenticeExam(userId);
      revalidatePath("/cabinet");
      revalidatePath("/cabinet/ag_apprentice");
      revalidatePath("/review");
      return { status: 200, body: { ok: true, ...result } };
    },
  });
}
