import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { memories } from "@/lib/db/schema";
import { logAudit } from "@/lib/audit";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const [memory] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, id));
    if (!memory) throw new Error("Memory not found");
    await db.delete(memories).where(eq(memories.id, id));
    await logAudit({
      userId: memory.userId,
      actor: "user",
      action: "memory.delete",
      target: id,
      before: { content: memory.content, type: memory.type },
      after: null,
    });
    revalidatePath("/memory");
    revalidatePath("/");
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    );
  }
}
