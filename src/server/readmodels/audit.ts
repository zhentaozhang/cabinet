import { auditPageSchema, type AuditPageDto } from "@/contracts";
import { asDto } from "@/server/dto-guard";
import { toAuditEventDto } from "@/server/mappers";
import { getAuditPage } from "@/server/services/queries/audit";

export async function loadAudit(
  userId: string,
  options: { limit?: number; offset?: number; kind?: string | null } = {},
): Promise<AuditPageDto> {
  const limit = clamp(options.limit ?? 40, 1, 200);
  const offset = Math.max(0, options.offset ?? 0);
  const data = await getAuditPage(userId, {
    limit,
    offset,
    kind: options.kind ?? null,
  });

  return asDto(
    auditPageSchema,
    {
      timezone: data.timezone,
      events: data.events.map(toAuditEventDto),
      kinds: data.kinds,
      kind: data.kind,
      total: data.total,
      filteredTotal: data.filteredTotal,
      offset: data.offset,
      limit: data.limit,
      hasMore: data.hasMore,
    },
    "AuditPage",
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
