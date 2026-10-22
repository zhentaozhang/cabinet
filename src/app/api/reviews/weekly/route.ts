import { revalidatePath } from "next/cache";
import { handleMutation } from "@/lib/api/mutation";
import { regenerateWeeklyReview } from "@/server/services/commands/reviews";

export async function POST(req: Request) {
  return handleMutation({
    request: req,
    endpoint: "reviews.weekly",
    handler: async (userId) => {
      const review = await regenerateWeeklyReview(userId);
      revalidatePath("/review");
      return { status: 200, body: { ok: true, review } };
    },
  });
}
