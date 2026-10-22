import { revalidatePath } from "next/cache";
import { decideCouncil } from "@/lib/engine";

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
    await decideCouncil(id, body.decision, body.note ?? "");
    revalidatePath("/");
    revalidatePath("/council");
    revalidatePath("/review");
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    );
  }
}
