import { revalidatePath } from "next/cache";
import { decideApproval } from "@/lib/engine";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = (await req.json()) as {
      decision?: "approve" | "reject";
      reason?: string;
    };
    if (!body.decision) throw new Error("decision is required");
    await decideApproval(id, body.decision, body.reason);
    revalidatePath("/");
    revalidatePath("/review");
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    );
  }
}
