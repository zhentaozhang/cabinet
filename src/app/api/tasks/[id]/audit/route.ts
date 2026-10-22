import { revalidatePath } from "next/cache";
import { auditTask } from "@/server/services/engine";
import { handleMutation } from "@/lib/api/mutation";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: `tasks.audit:${id}`,
    body,
    handler: async (userId) => {
      const result = await auditTask(id, userId);
      revalidatePath("/");
      revalidatePath("/cabinet");
      revalidatePath("/review");
      revalidatePath(`/tasks/${id}`);
      return { status: 200, body: { ok: true, ...result } };
    },
  });
}
