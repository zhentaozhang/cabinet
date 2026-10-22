import { revalidatePath } from "next/cache";
import { runReflection } from "@/lib/engine";

export async function POST() {
  try {
    const insight = await runReflection();
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
