import { deliveryPageSchema, type DeliveryPageDto } from "@/contracts";
import { asDto } from "@/server/dto-guard";
import { getDeliveryData } from "@/server/services/queries/delivery";

export async function loadDelivery(userId: string): Promise<DeliveryPageDto> {
  const data = await getDeliveryData(userId);

  return asDto(
    deliveryPageSchema,
    {
      timezone: data.timezone,
      prefs: data.prefs,
      email: data.email,
      counts: {
        pending: data.counts.pending ?? 0,
        sent: data.counts.sent ?? 0,
        failed: data.counts.failed ?? 0,
        skipped: data.counts.skipped ?? 0,
      },
      items: data.items.map((row) => ({
        id: row.id,
        kind: row.kind,
        subject: row.subject,
        body: row.body,
        status: row.status as DeliveryPageDto["items"][number]["status"],
        attempts: row.attempts,
        lastError: row.lastError,
        href: row.href,
        targetType: row.targetType,
        targetId: row.targetId,
        nextAttemptAt: row.nextAttemptAt.toISOString(),
        sentAt: row.sentAt ? row.sentAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
      })),
    },
    "DeliveryPage",
  );
}
