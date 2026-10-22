import { deleteAccount } from "@/lib/account";
import { handleMutation } from "@/lib/api/mutation";

export async function DELETE(req: Request) {
  return handleMutation({
    request: req,
    endpoint: "account.delete",
    handler: async (userId) => {
      await deleteAccount(userId);
      return { status: 200, body: { ok: true } };
    },
  });
}
