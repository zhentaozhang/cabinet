"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Brain,
  ClipboardCheck,
  Gavel,
  LogOut,
  Menu,
  RefreshCw,
  Settings,
  Sun,
  Users,
  X,
} from "lucide-react";
import type { ShellContextDto } from "@/contracts";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/format";

const NAV = [
  { href: "/", label: "Today", icon: Sun, hint: "每日闭环" },
  { href: "/cabinet", label: "Cabinet", icon: Users, hint: "组织与绩效" },
  { href: "/review", label: "Review", icon: ClipboardCheck, hint: "周复盘" },
  { href: "/memory", label: "Memory", icon: Brain, hint: "记忆与证据" },
  { href: "/council", label: "Council", icon: Gavel, hint: "内阁会议" },
  { href: "/settings", label: "Settings", icon: Settings, hint: "连接器与配置" },
];

const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

const DRAWER_ID = "mobile-nav-drawer";

// Everything a keyboard can reach, in DOM order. Shared by the initial focus and
// the Tab trap so both agree on what counts as focusable.
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Mark() {
  return (
    <div className="grid size-7 grid-cols-2 gap-[3px] rounded-md border border-accent/40 bg-accent/10 p-[5px]">
      <span className="rounded-[2px] bg-accent" />
      <span className="rounded-[2px] bg-accent/50" />
      <span className="rounded-[2px] bg-accent/50" />
      <span className="rounded-[2px] bg-accent" />
    </div>
  );
}

function matchesHref(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

function useActiveHref() {
  const pathname = usePathname();
  return (href: string) => matchesHref(pathname, href);
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const isActive = useActiveHref();
  return (
    <nav aria-label="主导航" className={cn("flex flex-col gap-1")}>
      {NAV.map((item) => {
        const active = isActive(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            aria-label={item.hint}
            onClick={onNavigate}
            className={cn(
              "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs transition-colors",
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

function ResetButton() {
  const router = useRouter();
  const [state, setState] = useState<
    "idle" | "confirm" | "busy" | "error"
  >("idle");

  async function reset() {
    setState("busy");
    try {
      const response = await fetch("/api/demo/reset", { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      router.refresh();
      setState("idle");
    } catch {
      setState("error");
    }
  }

  if (state === "confirm") {
    return (
      <div className="space-y-1">
        <button
          type="button"
          onClick={reset}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-label text-danger transition-colors hover:bg-danger/10",
            FOCUS_RING,
          )}
        >
          <RefreshCw aria-hidden="true" className="size-3" />
          确认重置演示数据
        </button>
        <button
          type="button"
          onClick={() => setState("idle")}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-label text-faint transition-colors hover:bg-white/[0.04]",
            FOCUS_RING,
          )}
        >
          取消
        </button>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setState("confirm")}
        disabled={state === "busy"}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-label transition-colors hover:bg-white/[0.04] disabled:opacity-50",
          state === "error" ? "text-danger" : "text-faint hover:text-muted",
          FOCUS_RING,
        )}
      >
        <RefreshCw
          aria-hidden="true"
          className={cn("size-3", state === "busy" && "animate-spin")}
        />
        {state === "busy"
          ? "重置中…"
          : state === "error"
            ? "重置失败，点此重试"
            : "重置演示数据"}
      </button>
      <p aria-live="polite" className="sr-only">
        {state === "error" ? "重置演示数据失败" : ""}
      </p>
    </div>
  );
}

function AutonomyPanel({ context }: { context: ShellContextDto | null }) {
  const autonomy = context?.autonomy ?? { l1: 0, l2: 0, l3: 0 };
  const counts = [autonomy.l1, autonomy.l2, autonomy.l3];
  const highest = counts.reduce((acc, count, index) => (count > 0 ? index + 1 : acc), 0);

  return (
    <div className="mb-3 rounded-lg border border-line bg-panel2/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-eyebrow uppercase tracking-[0.16em] text-faint">
          Autonomy
        </span>
        <span className="mono text-label text-accent">L{highest}</span>
      </div>
      <div className="flex items-center gap-1">
        {[1, 2, 3].map((rung) => {
          const reached = (counts[rung - 1] ?? 0) > 0;
          return (
            <div key={rung} className="flex-1">
              <div
                className={cn("h-1 rounded-full", reached ? "bg-accent" : "bg-line2")}
              />
              <div className="mt-1 text-label text-faint">L{rung}</div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-label leading-relaxed text-muted">
        {context && context.agents > 0
          ? `${context.agents} 位在岗，L2+ ${autonomy.l2} 位`
          : "授权靠信用和审计，不靠信任。"}
      </div>
    </div>
  );
}

/**
 * The body of the navigation surface: links, autonomy, account, reset. Desktop
 * renders it inside the fixed aside, mobile inside the drawer, so both show the
 * same information without duplicating the markup.
 */
function SidebarBody({
  context,
  displayName,
  displayEmail,
  showSignOut,
  showReset,
  onNavigate,
}: {
  context: ShellContextDto | null;
  displayName: string;
  displayEmail: string;
  showSignOut: boolean;
  showReset: boolean;
  onNavigate?: () => void;
}) {
  const router = useRouter();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="px-3">
        <NavLinks onNavigate={onNavigate} />
      </div>

      <div className="mt-auto border-t border-line p-3">
        <AutonomyPanel context={context} />

        <div className="mb-2 flex items-center gap-2 px-1">
          <div
            aria-hidden="true"
            className="flex size-6 items-center justify-center rounded-md border border-line2 bg-panel2 text-label text-muted"
          >
            {displayName.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-label font-medium text-ink">
              {displayName}
            </div>
            <div className="truncate text-label text-faint">{displayEmail}</div>
          </div>
          <Link
            href="/setup"
            aria-label="工作区设置"
            title="工作区设置"
            onClick={onNavigate}
            className={cn(
              "rounded p-1 text-faint transition-colors hover:bg-white/[0.04] hover:text-muted",
              FOCUS_RING,
            )}
          >
            <Settings aria-hidden="true" className="size-3" />
          </Link>
          {showSignOut ? (
            <button
              type="button"
              aria-label="退出登录"
              onClick={async () => {
                await authClient.signOut();
                router.push("/login");
                router.refresh();
              }}
              className={cn(
                "rounded p-1 text-faint hover:bg-white/[0.04] hover:text-muted",
                FOCUS_RING,
              )}
            >
              <LogOut aria-hidden="true" className="size-3" />
            </button>
          ) : null}
        </div>
        {showReset ? <ResetButton /> : null}
      </div>
    </div>
  );
}

export function Shell({
  children,
  context = null,
}: {
  children: React.ReactNode;
  context?: ShellContextDto | null;
}) {
  const pathname = usePathname();
  const { data: session } = authClient.useSession();
  const sessionUser = session?.user;
  const displayName = sessionUser?.name ?? context?.name ?? "Zhen";
  const displayEmail = sessionUser?.email ?? context?.email ?? "demo workspace";
  const showSignOut = Boolean(sessionUser);
  const showReset = !sessionUser || sessionUser.email === "demo@cabinet.local";

  const currentItem = NAV.find((item) => matchesHref(pathname, item.href));
  const pageTitle = currentItem?.hint ?? "CABINET";

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPath, setMenuPath] = useState(pathname);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // A route change must close the drawer — including browser back/forward, where
  // no link is clicked. This is React's documented "adjust state when an input
  // changes" pattern (set during render, guarded), because closing from a
  // useEffect trips `react-hooks/set-state-in-effect` (an error in this repo).
  if (menuPath !== pathname) {
    setMenuPath(pathname);
    setMenuOpen(false);
  }

  useEffect(() => {
    if (!menuOpen) return;
    const drawer = drawerRef.current;
    // Copied out of the ref so the cleanup (and the frame callback) use the node
    // this effect started with instead of whatever the ref points at later.
    const trigger = triggerRef.current;
    const previousFocus = document.activeElement;

    // aria-modal hides the page from screen readers, but the page behind still
    // scrolls on wheel/touch (and iOS rubber-bands), which makes the drawer feel
    // broken. Lock it here and restore the original value on cleanup.
    const body = document.body;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";

    // Wait one frame so the panel is laid out and no longer `inert`.
    const frame = requestAnimationFrame(() => {
      drawer?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const nodes = Array.from(
        drawer?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      );
      if (nodes.length === 0) {
        event.preventDefault();
        drawer?.focus();
        return;
      }

      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const inside = drawer?.contains(document.activeElement) ?? false;
      if (event.shiftKey) {
        if (!inside || document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Widening past `md` reveals the desktop aside; drop the lock and the trap
    // with it instead of leaving a hidden drawer holding the page frozen.
    const desktop = window.matchMedia("(min-width: 768px)");
    const handleViewportChange = (event: MediaQueryListEvent) => {
      if (event.matches) setMenuOpen(false);
    };

    document.addEventListener("keydown", handleKeyDown);
    desktop.addEventListener("change", handleViewportChange);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      desktop.removeEventListener("change", handleViewportChange);
      body.style.overflow = previousOverflow;
      // Return focus to whatever opened the drawer (the trigger); fall back to
      // it explicitly when the remembered node is gone.
      const target =
        previousFocus instanceof HTMLElement && previousFocus.isConnected
          ? previousFocus
          : trigger;
      target?.focus();
    };
  }, [menuOpen]);

  return (
    <div className="relative z-10 min-h-screen">
      <a
        href="#main"
        className={cn(
          "sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-panel focus:px-3 focus:py-2 focus:text-xs focus:text-ink",
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

      {/*
        Rendered at all times so the slide runs in both directions: hidden state is
        `-translate-x-full` + `inert` + `aria-hidden`, which keeps it out of the
        tab order and the accessibility tree while staying transitionable.
      */}
      <div className="md:hidden">
        <div
          aria-hidden="true"
          onClick={() => setMenuOpen(false)}
          className={cn(
            "fixed inset-0 z-40 bg-black/60 transition-opacity duration-200 motion-reduce:transition-none",
            menuOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        />

        <div
          id={DRAWER_ID}
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label="导航菜单"
          aria-hidden={!menuOpen}
          inert={!menuOpen}
          className={cn(
            "fixed inset-y-0 left-0 z-50 flex w-[268px] flex-col border-r border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] shadow-[0_0_48px_-12px_rgba(0,0,0,0.85)] backdrop-blur-xl transition-transform duration-200 ease-out motion-reduce:transition-none",
            menuOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="flex items-center gap-2.5 px-4 pb-4 pt-5">
            <Mark />
            <div className="min-w-0 flex-1">
              <div className="text-title font-semibold tracking-[0.16em] text-ink">
                CABINET
              </div>
              <div className="text-label tracking-wide text-faint">
                personal agent org
              </div>
            </div>
            <button
              type="button"
              onClick={() => setMenuOpen(false)}
              aria-label="关闭菜单"
              className={cn(
                "shrink-0 rounded-md border border-line p-1.5 text-faint transition-colors hover:border-line2 hover:text-ink",
                FOCUS_RING,
              )}
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>

          <SidebarBody
            context={context}
            displayName={displayName}
            displayEmail={displayEmail}
            showSignOut={showSignOut}
            showReset={showReset}
            onNavigate={() => setMenuOpen(false)}
          />
        </div>
      </div>

      <main id="main" className="md:ml-[232px]">
        <div className="mx-auto w-full max-w-[1180px] px-4 pt-6 pb-10 sm:px-6 md:px-8 md:py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
