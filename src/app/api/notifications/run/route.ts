import { revalidatePath } from "next/cache";

import { API_ROUTES } from "@/contracts";
import { handleMutation } from "@/lib/api/mutation";
import { deliverOutbox } from "@/server/services/commands/delivery";

export const dynamic = "force-dynamic";

/**
 * One pass sends at most this many mails, so a slow SMTP server cannot outlive
 * the browser's 20s request timeout (the client aborts and would then retry
 * with the same idempotency key). The cron job is not bound by this.
 */
const MANUAL_PASS_LIMIT = 5;
export const maxDuration = 30;

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
      const report = await deliverOutbox({ userId, limit: MANUAL_PASS_LIMIT });
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
          waiting: report.waiting,
          claimed: report.claimed,
          // The lease was taken over mid-flight: the UI reports it instead of
          // pretending this pass did nothing (contract: deliveryRunSchema).
          lost: report.lost,
        },
      };
    },
  });
}
