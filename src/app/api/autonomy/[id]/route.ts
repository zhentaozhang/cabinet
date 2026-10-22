import { revalidatePath } from "next/cache";
import { setAutonomy } from "@/lib/engine";
import { toErrorResponse } from "@/lib/domain/errors";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = (await req.json()) as { level?: number };
    if (typeof body.level !== "number") throw new Error("level is required");
    const result = await setAutonomy(id, body.level);
    revalidatePath("/cabinet");
    revalidatePath(`/cabinet/${id}`);
    revalidatePath("/");
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
