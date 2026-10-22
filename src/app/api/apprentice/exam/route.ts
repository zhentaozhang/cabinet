import { revalidatePath } from "next/cache";
import { runApprenticeExam } from "@/lib/engine";
import { getApiUserId } from "@/lib/auth/context";
import { toErrorResponse } from "@/lib/domain/errors";

export async function POST() {
  try {
    const userId = await getApiUserId();
    const result = await runApprenticeExam(userId);
    revalidatePath("/cabinet");
    revalidatePath("/cabinet/ag_apprentice");
    revalidatePath("/review");
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
