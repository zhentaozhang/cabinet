import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Project tokens (`text-label`, `text-muted`, …) are not Tailwind defaults, so
 * `tailwind-merge` cannot tell a font size from a text colour and would drop one
 * of `"text-label text-muted"`. Teaching it the two groups keeps arbitrary
 * token strings mergeable while still resolving real conflicts.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["eyebrow", "label", "body", "emphasis", "title", "section", "page"] },
      ],
      "text-color": [
        {
          text: [
            "ink",
            "muted",
            "faint",
            "accent",
            "teal",
            "danger",
            "blue",
            "violet",
            "bg",
            "panel",
            "panel2",
            "panel-raised",
            "line",
            "line2",
            "hairline",
          ],
        },
      ],
      "bg-color": [
        {
          bg: [
            "bg",
            "panel",
            "panel2",
            "panel-raised",
            "line",
            "line2",
            "hairline",
            "ink",
            "muted",
            "faint",
            "accent",
            "teal",
            "danger",
            "blue",
            "violet",
          ],
        },
      ],
      "border-color": [
        {
          border: [
            "line",
            "line2",
            "hairline",
            "ink",
            "muted",
            "faint",
            "accent",
            "teal",
            "danger",
            "blue",
            "violet",
          ],
        },
      ],
    },
  },
});

/** Combine class names, resolving conflicting project utilities by call order. */
export function cn(...parts: Array<string | false | null | undefined>) {
  return twMerge(clsx(parts));
}

export function pct(value: number): string {
  return `${Math.round(value)}%`;
}

export function money(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

export function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

type DateFormatKind = "shortDate" | "dateTime" | "timeOnly";

/**
 * `new Intl.DateTimeFormat()` resolves locale and time-zone data on every
 * construction and is a known CPU hotspot: one task page formats 20+ timestamps
 * per render. Instances are therefore cached for the lifetime of the process.
 *
 * Only the formatter is cached — never a `Date` or a formatted string — so the
 * helpers keep identical semantics and nothing stale can leak between calls.
 *
 * A cache key must carry the format kind *and* the time zone: a key that omitted
 * the zone would hand a formatter built for Asia/Shanghai to a caller asking for
 * UTC and silently format in the wrong zone. `undefined` means "runtime default
 * zone", so it is encoded with a sentinel that no IANA zone name can contain
 * (zone names have no NUL) and can never collide with a named zone.
 */
const NO_TIME_ZONE = "\u0000default";

const formatterCache = new Map<string, Intl.DateTimeFormat>();

const FORMAT_OPTIONS: Record<DateFormatKind, Intl.DateTimeFormatOptions> = {
  shortDate: { month: "2-digit", day: "2-digit" },
  dateTime: {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  },
  timeOnly: { hour: "2-digit", minute: "2-digit" },
};

/** Cached formatter for one (kind, timeZone) pair; the key space stays tiny. */
function dateFormatter(
  kind: DateFormatKind,
  timeZone?: string,
): Intl.DateTimeFormat {
  const key = `${kind}|${timeZone ?? NO_TIME_ZONE}`;
  const cached = formatterCache.get(key);
  if (cached) return cached;

  // Built inside the miss branch: an invalid zone throws here, and a throwing
  // construction must leave no entry behind rather than cache a broken one.
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    ...FORMAT_OPTIONS[kind],
    timeZone,
  });
  formatterCache.set(key, formatter);
  return formatter;
}

export function shortDate(
  value: Date | string | null | undefined,
  timeZone?: string,
): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return dateFormatter("shortDate", timeZone).format(d);
}

export function dateTime(
  value: Date | string | null | undefined,
  timeZone?: string,
): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return dateFormatter("dateTime", timeZone).format(d);
}

export function timeOnly(
  value: Date | string | null | undefined,
  timeZone?: string,
): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return dateFormatter("timeOnly", timeZone).format(d);
}

export function weekLabel(date = new Date()): string {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + 3);
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getDay() + 6) % 7)) /
        7,
    );
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function relative(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}
