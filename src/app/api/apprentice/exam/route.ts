import { revalidatePath } from "next/cache";
import { runApprenticeExam } from "@/lib/engine";
import { toErrorResponse } from "@/lib/domain/errors";

export async function POST() {
  try {
    const result = await runApprenticeExam();
    revalidatePath("/cabinet");
    revalidatePath("/cabinet/ag_apprentice");
    revalidatePath("/review");
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
