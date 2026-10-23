import { revalidatePath } from "next/cache";

import { handleMutation } from "@/lib/api/mutation";
import { revokeGrant } from "@/server/services/commands/tasks/grants";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  return handleMutation({
    request: req,
    endpoint: `grants.revoke:${id}`,
    handler: async (userId) => {
      await revokeGrant(id, userId);
      revalidatePath("/cabinet");
      return { status: 200, body: { ok: true } };
    },
  });
}
