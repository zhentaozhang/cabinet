import { revalidatePath } from "next/cache";
import { updateAgent } from "@/lib/engine";
import { toErrorResponse } from "@/lib/domain/errors";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = (await req.json()) as {
      status?: "active" | "paused" | "retired";
      charter?: string;
      budgetCents?: number;
    };
    const agent = await updateAgent(id, body);
    revalidatePath("/cabinet");
    revalidatePath(`/cabinet/${id}`);
    revalidatePath("/");
    return Response.json({ ok: true, agent });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
