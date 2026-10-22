import { revalidatePath } from "next/cache";
import { applyInsight } from "@/lib/engine";
import { getApiUserId } from "@/lib/auth/context";
import { toErrorResponse } from "@/lib/domain/errors";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = (await req.json()) as {
      action?: "accept" | "reject" | "rollback";
    };
    if (!body.action) throw new Error("action is required");
    const userId = await getApiUserId();
    await applyInsight(id, body.action, userId);
    revalidatePath("/");
    revalidatePath("/review");
    revalidatePath("/memory");
    return Response.json({ ok: true });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
