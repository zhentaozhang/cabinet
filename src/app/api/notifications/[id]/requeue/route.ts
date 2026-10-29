import { revalidatePath } from "next/cache";

import { handleMutation } from "@/lib/api/mutation";
import { requeueOutbox } from "@/server/services/commands/delivery";

/**
 * Put one failed notification back in the queue.
 *
 * Scoped to the signed-in account inside the command, so an id from another
 * account answers 404 instead of revealing that the row exists.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleMutation({
    request,
    endpoint: `notifications.requeue:${id}`,
    handler: async (userId) => {
      const row = await requeueOutbox(userId, id);
      revalidatePath("/settings/notifications");
      return { status: 200, body: { ok: true, id: row.id } };
    },
  });
}