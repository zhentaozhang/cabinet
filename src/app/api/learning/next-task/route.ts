import { revalidatePath } from "next/cache";
import { handleMutation } from "@/lib/api/mutation";
import { ensureNextLearningTask } from "@/server/services/commands/learning";

export async function POST(req: Request) {
  return handleMutation({
    request: req,
    endpoint: "learning.next-task",
    handler: async (userId) => {
      const task = await ensureNextLearningTask(userId);
      revalidatePath("/");
      revalidatePath("/review");
      return { status: 200, body: { ok: true, task } };
    },
  });
}
