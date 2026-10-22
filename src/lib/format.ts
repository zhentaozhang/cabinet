import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Projects tokens (`text-micro`, `text-muted`, …) are not Tailwind defaults, so
 * `tailwind-merge` cannot tell a font size from a text colour and would drop one
 * of `"text-micro text-muted"`. Teaching it the two groups keeps arbitrary
 * token strings mergeable while still resolving real conflicts.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["nano", "mini", "micro", "caption", "subhead"] },
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
            "panel-base",
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
            "bg-void",
            "panel",
            "panel-base",
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

export function shortDate(
  value: Date | string | null | undefined,
  timeZone?: string,
): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(d);
}

export function dateTime(
  value: Date | string | null | undefined,
  timeZone?: string,
): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(d);
}

export function timeOnly(
  value: Date | string | null | undefined,
  timeZone?: string,
): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(d);
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
