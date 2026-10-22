import { revalidatePath } from "next/cache";
import { regenerateBrief } from "@/lib/engine";
import { getApiUserId } from "@/lib/auth/context";

export async function POST() {
  try {
    const userId = await getApiUserId();
    const brief = await regenerateBrief(userId);
    revalidatePath("/");
    return Response.json({ ok: true, brief });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    );
  }
}
