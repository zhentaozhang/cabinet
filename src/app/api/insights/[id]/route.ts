import { revalidatePath } from "next/cache";
import { applyInsight } from "@/lib/engine";

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
    await applyInsight(id, body.action);
    revalidatePath("/");
    revalidatePath("/review");
    revalidatePath("/memory");
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    );
  }
}
