"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { Menu, Settings } from "lucide-react";
import type { ShellContextDto } from "@/contracts";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/format";
import { Mark } from "./mark";
import { MobileDrawer } from "./mobile-drawer";
import { DRAWER_ID, FOCUS_RING, matchesHref, NAV } from "./nav";
import { SidebarBody } from "./sidebar-body";

/**
 * The app frame: a fixed aside on desktop, a sticky bar plus slide-over drawer
 * on mobile, and the content column both share.
 *
 * Everything with its own state lives in a child (`MobileDrawer` owns the focus
 * trap, `ResetButton` owns the confirm flow), so this component stays readable
 * as the product grows.
 */
export function Shell({
  children,
  context = null,
  demoResetEnabled = false,
}: {
  children: React.ReactNode;
  context?: ShellContextDto | null;
  /** 由服务端 `demoResetAllowed()` 传入：端点在不在，按钮就在不在。 */
  demoResetEnabled?: boolean;
}) {
  const pathname = usePathname();
  const { data: session } = authClient.useSession();
  const sessionUser = session?.user;
  const displayName = sessionUser?.name ?? context?.name ?? "Zhen";
  const displayEmail = sessionUser?.email ?? context?.email ?? "demo workspace";
  const showSignOut = Boolean(sessionUser);
  // 按钮原来只问「谁在登录」：默认配置（DEMO_MODE=false、
  // DEMO_RESET_ENABLED=false、AUTH_REQUIRED 未设）下它照样显示，点下去端点
  // 404，界面只能停在「重置失败」。可见性必须跟 `/api/demo/reset` 的开关同源，
  // 所以由服务端算好传进来（客户端读不到这两个环境变量）。
  const showReset =
    demoResetEnabled &&
    (!sessionUser || sessionUser.email === "demo@cabinet.local");

  const currentItem = NAV.find((item) => matchesHref(pathname, item.href));
  const pageTitle = currentItem?.hint ?? "CABINET";

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPath, setMenuPath] = useState(pathname);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Stable identity: `MobileDrawer` runs its focus trap in an effect keyed on
  // this, and an inline arrow would re-run the trap (and steal focus) on every
  // render of the shell.
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // A route change must close the drawer — including browser back/forward, where
  // no link is clicked. This is React's documented "adjust state when an input
  // changes" pattern (set during render, guarded), because closing from a
  // useEffect trips `react-hooks/set-state-in-effect` (an error in this repo).
  if (menuPath !== pathname) {
    setMenuPath(pathname);
    setMenuOpen(false);
  }

  return (
    <div className="relative z-10 min-h-screen">
      <a
        href="#main"
        className={cn(
          "sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-panel focus:px-3 focus:py-2 focus:text-label focus:text-ink",
          FOCUS_RING,
        )}
      >
        跳到主内容
      </a>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col border-r border-line bg-panel/70 backdrop-blur-xl md:flex">
        <div className="flex items-center gap-2.5 px-5 pb-5 pt-6">
          <Mark />
          <div>
            <div className="text-title font-semibold tracking-[0.16em] text-ink">
              CABINET
            </div>
            <div className="text-label tracking-wide text-faint">
              personal agent org
            </div>
          </div>
        </div>

        <SidebarBody
          context={context}
          displayName={displayName}
          displayEmail={displayEmail}
          showSignOut={showSignOut}
          showReset={showReset}
        />
      </aside>

      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-bg/85 px-3 py-2.5 backdrop-blur-xl md:hidden">
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={menuOpen}
          aria-controls={DRAWER_ID}
          onClick={() => setMenuOpen(true)}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-panel2/70 px-2.5 py-1.5 text-label font-medium text-muted transition-colors hover:border-line2 hover:text-ink",
            FOCUS_RING,
          )}
        >
          <Menu aria-hidden="true" className="size-3.5" />
          菜单
        </button>

        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium text-ink">
            {pageTitle}
          </div>
        </div>

        <Link
          href="/setup"
          aria-label="工作区设置"
          className={cn(
            "shrink-0 rounded-md border border-line p-1.5 text-faint transition-colors hover:text-muted",
            FOCUS_RING,
          )}
        >
          <Settings aria-hidden="true" className="size-3.5" />
        </Link>
      </header>

      <MobileDrawer
        open={menuOpen}
        onClose={closeMenu}
        context={context}
        displayName={displayName}
        displayEmail={displayEmail}
        showSignOut={showSignOut}
        showReset={showReset}
        triggerRef={triggerRef}
      />

      {/* `tabIndex={-1}` lets the skip link and the drawer's viewport-change
          exit move focus here programmatically, without adding a stop to the
          normal tab order. */}
      <main id="main" tabIndex={-1} className="md:ml-[232px] outline-none">
        <div className="mx-auto w-full max-w-[1180px] px-4 pt-6 pb-10 sm:px-6 md:px-8 md:py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
