"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/format";
import { FOCUS_RING, isExactHref, matchesHref, NAV } from "./nav";

function useActiveHref() {
  const pathname = usePathname();
  return {
    /** Highlight the whole section, including its sub-pages. */
    isActive: (href: string) => matchesHref(pathname, href),
    /** Announce only the page actually being viewed. */
    isCurrentPage: (href: string) => isExactHref(pathname, href),
  };
}

/** The six destinations. Same data drives the desktop aside and the drawer. */
export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { isActive, isCurrentPage } = useActiveHref();
  return (
    <nav aria-label="主导航" className={cn("flex flex-col gap-1")}>
      {NAV.map((item) => {
        const active = isActive(item.href);
        const current = isCurrentPage(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={current ? "page" : undefined}
            /* The visible word is the accessible name. Putting the hint in
               `aria-label` would rename the link for screen readers and break
               "click the thing you can see" (WCAG 2.5.3). */
            title={item.hint}
            onClick={onNavigate}
            className={cn(
              "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-label transition-colors",
              FOCUS_RING,
              active
                ? "bg-white/[0.06] text-ink"
                : "text-muted hover:bg-white/[0.03] hover:text-ink",
            )}
          >
            <Icon
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0",
                active ? "text-accent" : "text-faint group-hover:text-muted",
              )}
            />
            <span className="font-medium">{item.label}</span>
            <span
              aria-hidden="true"
              className="ml-auto hidden text-label text-faint lg:block"
            >
              {active ? "●" : ""}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
