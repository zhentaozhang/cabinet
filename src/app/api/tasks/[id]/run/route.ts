import { revalidatePath } from "next/cache";
import { runTask } from "@/lib/engine";
import { toErrorResponse } from "@/lib/domain/errors";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const result = await runTask(id);
    revalidatePath("/");
    revalidatePath("/cabinet");
    revalidatePath("/review");
    revalidatePath(`/tasks/${id}`);
    return Response.json(
      { ok: true, ...result },
      { status: result.requiresApproval ? 202 : 200 },
    );
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
