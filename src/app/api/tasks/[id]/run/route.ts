import { revalidatePath } from "next/cache";
import { runTask } from "@/lib/engine";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const result = await runTask(id);
    revalidatePath("/");
    revalidatePath("/cabinet");
    revalidatePath("/review");
    revalidatePath(`/tasks/${id}`);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "run failed" },
      { status: 400 },
    );
  }
}
