import { revalidatePath } from "next/cache";

import { API_ROUTES } from "@/contracts";
import { handleMutation } from "@/lib/api/mutation";
import { deliverOutbox } from "@/server/services/commands/delivery";

export const dynamic = "force-dynamic";

/**
 * One manual delivery pass for the current account.
 *
 * The scheduled job runs `notify:deliver` outside the web process; this exists
 * so an operator can see what would happen without waiting for the next tick.
 */
export function POST(request: Request) {
  return handleMutation({
    request,
    endpoint: "notifications:run",
    handler: async (userId) => {
      const report = await deliverOutbox({ userId, limit: 20 });
      revalidatePath("/settings/notifications");
      revalidatePath(API_ROUTES.notifications);
      return {
        status: 200,
        body: {
          ok: true,
          sent: report.sent,
          failed: report.failed,
          skipped: report.skipped,
          deferred: report.deferred,
          claimed: report.claimed,
        },
      };
    },
  });
}
