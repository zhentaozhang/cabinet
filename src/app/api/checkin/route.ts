import { revalidatePath } from "next/cache";
import { saveCheckin } from "@/server/services/engine";
import { handleMutation } from "@/lib/api/mutation";
import { checkinSchema } from "@/lib/validation/schemas";
import { parseBody } from "@/lib/validation/parse";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: "checkin.save",
    body,
    handler: async (userId) => {
      const input = parseBody(checkinSchema, body);
      await saveCheckin(input, userId);
      revalidatePath("/");
      revalidatePath("/memory");
      return { status: 200, body: { ok: true } };
    },
  });
}
