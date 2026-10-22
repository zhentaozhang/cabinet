import { revalidatePath } from "next/cache";
import { runReflection } from "@/lib/engine";
import { getApiUserId } from "@/lib/auth/context";

export async function POST() {
  try {
    const userId = await getApiUserId();
    const insight = await runReflection(userId);
    revalidatePath("/review");
    revalidatePath("/");
    return Response.json({ ok: true, insightId: insight.id });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    );
  }
}
