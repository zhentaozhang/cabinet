import { revalidatePath } from "next/cache";
import { regenerateBrief } from "@/lib/engine";

export async function POST() {
  try {
    const brief = await regenerateBrief();
    revalidatePath("/");
    return Response.json({ ok: true, brief });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    );
  }
}
