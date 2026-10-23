import {
  Brain,
  ClipboardCheck,
  Gavel,
  Settings,
  Sun,
  Users,
} from "lucide-react";

/**
 * The six surfaces of the product, in the order a day moves through them. Kept
 * as data so the desktop aside and the mobile drawer can never drift apart.
 */
export const NAV = [
  { href: "/", label: "Today", icon: Sun, hint: "每日闭环" },
  { href: "/cabinet", label: "Cabinet", icon: Users, hint: "组织与绩效" },
  { href: "/review", label: "Review", icon: ClipboardCheck, hint: "周复盘" },
  { href: "/memory", label: "Memory", icon: Brain, hint: "记忆与证据" },
  { href: "/council", label: "Council", icon: Gavel, hint: "内阁会议" },
  { href: "/settings", label: "Settings", icon: Settings, hint: "连接器与配置" },
];

export const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

export const DRAWER_ID = "mobile-nav-drawer";

// Everything a keyboard can reach, in DOM order. Shared by the initial focus and
// the Tab trap so both agree on what counts as focusable.
export const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Does this route belong to this nav section?
 *
 * The root matches only itself, otherwise Today would look current everywhere.
 * Nested routes match their section, but only on a path boundary: a bare
 * `startsWith` would let `/reviews` light up `/review` and tell the reader they
 * are somewhere they are not.
 */
/**
 * True when `pathname` *is* `href`, as opposed to merely living under it.
 *
 * `aria-current="page"` claims "you are on this page". On `/settings/connectors`
 * the `/settings` entry is the right section to highlight visually, but the
 * connector settings are not the settings index, so announcing it as the current
 * page misreports the location to a screen reader. Highlight on `matchesHref`,
 * announce on `isExactHref`.
 */
export function isExactHref(pathname: string, href: string) {
  return pathname === href;
}

export function matchesHref(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
