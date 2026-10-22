import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { logAudit } from "@/lib/audit";
import { handleMutation } from "@/lib/api/mutation";
import { db } from "@/lib/db";
import { memories } from "@/lib/db/schema";
import { NotFoundError } from "@/lib/domain/errors";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  return handleMutation({
    request,
    endpoint: "memories:delete",
    handler: async (userId) => {
      const [memory] = await db
        .select()
        .from(memories)
        .where(and(eq(memories.id, id), eq(memories.userId, userId)));

      if (!memory) throw new NotFoundError("记忆不存在");

      await db
        .delete(memories)
        .where(and(eq(memories.id, id), eq(memories.userId, userId)));

      await logAudit({
        userId,
        actor: "user",
        action: "memory.delete",
        target: id,
        before: { content: memory.content, type: memory.type },
        after: null,
      });

      revalidatePath("/memory");
      revalidatePath("/");

      return { status: 200, body: { ok: true } };
    },
  });
}
