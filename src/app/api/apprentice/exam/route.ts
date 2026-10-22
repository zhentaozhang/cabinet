import { revalidatePath } from "next/cache";
import { runApprenticeExam } from "@/lib/engine";

export async function POST() {
  try {
    const result = await runApprenticeExam();
    revalidatePath("/cabinet");
    revalidatePath("/cabinet/ag_apprentice");
    revalidatePath("/review");
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    );
  }
}
