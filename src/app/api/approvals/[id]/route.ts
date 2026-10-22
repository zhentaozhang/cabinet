import { revalidatePath } from "next/cache";
import { decideApproval } from "@/lib/engine";
import { toErrorResponse } from "@/lib/domain/errors";

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
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
