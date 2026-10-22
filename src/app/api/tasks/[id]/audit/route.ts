import { revalidatePath } from "next/cache";
import { auditTask } from "@/lib/engine";
import { getApiUserId } from "@/lib/auth/context";
import { toErrorResponse } from "@/lib/domain/errors";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const userId = await getApiUserId();
    const result = await auditTask(id, userId);
    revalidatePath("/");
    revalidatePath("/cabinet");
    revalidatePath("/review");
    revalidatePath(`/tasks/${id}`);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
