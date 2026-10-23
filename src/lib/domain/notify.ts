/**
 * Quiet hours are stored as two local hours ("22" to "8"). Everything here is
 * pure so the schedule can be unit-tested without a clock or a database.
 */

/** True when `hour` falls inside [from, to); wraps midnight when from > to. */
export function isQuietHour(hour: number, from: number, to: number): boolean {
  if (!Number.isFinite(hour) || !Number.isFinite(from) || !Number.isFinite(to)) {
    return false;
  }
  if (from === to) return false;
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

/** Local hour (0–23) of `at` in `timezone`, or null if the zone is unknown. */
export function localHour(at: Date, timezone: string): number | null {
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    }).format(at);
    const hour = Number(formatted.replace(/[^0-9]/g, ""));
    return Number.isFinite(hour) ? hour % 24 : null;
  } catch {
    return null;
  }
}

/**
 * Earliest instant a message may be delivered.
 *
 * Outside the quiet window this is `at` itself. Inside it, we advance to the
 * window's end. DST transitions are ignored: worst case the delivery lands an
 * hour early or late on two days a year, which is acceptable for a digest.
 */
export function nextDeliveryAt(
  at: Date,
  timezone: string,
  quietFrom: number,
  quietTo: number,
): Date {
  const hour = localHour(at, timezone);
  if (hour === null || !isQuietHour(hour, quietFrom, quietTo)) return at;

  const hoursUntilEnd = ((quietTo - hour + 24) % 24) || 24;
  return new Date(at.getTime() + hoursUntilEnd * 60 * 60 * 1000);
}

/** Backoff after a failed attempt: 1 min, 5 min, 15 min, then roughly hourly. */
export function retryDelayMs(attempts: number): number {
  const schedule = [60_000, 300_000, 900_000];
  const index = Math.min(Math.max(attempts, 1), schedule.length) - 1;
  return index >= 0 ? schedule[index] : 900_000;
}

export const MAX_ATTEMPTS = 4;
