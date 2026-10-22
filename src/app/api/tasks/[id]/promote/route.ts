import { revalidatePath } from "next/cache";
import { promoteSuggestion } from "@/lib/engine";
import { toErrorResponse } from "@/lib/domain/errors";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await promoteSuggestion(id);
    revalidatePath("/");
    revalidatePath(`/tasks/${id}`);
    return Response.json({ ok: true });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
