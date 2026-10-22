import { revalidatePath } from "next/cache";
import { setAutonomy } from "@/lib/engine";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = (await req.json()) as { level?: number };
    if (typeof body.level !== "number") throw new Error("level is required");
    await setAutonomy(id, body.level);
    revalidatePath("/cabinet");
    revalidatePath(`/cabinet/${id}`);
    revalidatePath("/");
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    );
  }
}
