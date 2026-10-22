import { revalidatePath } from "next/cache";
import { decideCouncil } from "@/lib/engine";
import { getApiUserId } from "@/lib/auth/context";
import { toErrorResponse } from "@/lib/domain/errors";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = (await req.json()) as {
      decision?: "approve" | "reject" | "conditions";
      note?: string;
    };
    if (!body.decision) throw new Error("decision is required");
    const userId = await getApiUserId();
    await decideCouncil(id, body.decision, body.note ?? "", userId);
    revalidatePath("/");
    revalidatePath("/council");
    revalidatePath("/review");
    return Response.json({ ok: true });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
