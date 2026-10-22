import type { z } from "zod";

import { logEvent } from "@/lib/obs/context";

/**
 * Server-side contract enforcement.
 *
 * A read model that drifts from its DTO fails here with the offending path,
 * instead of shipping `undefined` into a server component and failing later as
 * an unreadable render error.
 */
export function asDto<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  const detail = parsed.error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");

  // Contract drift is our bug, not the user's: log it at error level so the
  // failing read model is identifiable from the log line alone, then throw.
  logEvent("error", "dto.violation", { label, detail });

  throw new Error(`[dto] ${label} violates its contract → ${detail}`);
}
