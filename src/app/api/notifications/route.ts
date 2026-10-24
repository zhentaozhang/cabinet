import { revalidatePath } from "next/cache";

import { handleMutation } from "@/lib/api/mutation";
import { handleQueryWithRequest } from "@/lib/api/read";
import { parseBody } from "@/lib/validation/parse";
import { notifyPrefsSchema } from "@/contracts";
import { loadDelivery } from "@/server/readmodels/delivery";
import { updateNotifyPrefs } from "@/server/services/commands/notify";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const url = new URL(request.url);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 30);
  return handleQueryWithRequest(request, (userId) =>
    loadDelivery(userId, {
      offset: Number.isFinite(offset) ? offset : 0,
      limit: Number.isFinite(limit) ? limit : 30,
    }),
  );
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: "notifications.prefs",
    body,
    handler: async (userId) => {
      const input = parseBody(notifyPrefsSchema, body);
      await updateNotifyPrefs(userId, input);
      revalidatePath("/settings/notifications");
      revalidatePath("/");
      return { status: 200, body: { ok: true, ...input } };
    },
  });
}
