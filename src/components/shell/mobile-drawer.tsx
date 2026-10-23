"use client";

import { useEffect, useRef, type RefObject } from "react";
import { X } from "lucide-react";
import type { ShellContextDto } from "@/contracts";
import { cn } from "@/lib/format";
import { Mark } from "./mark";
import { DRAWER_ID, FOCUSABLE, FOCUS_RING } from "./nav";
import { SidebarBody } from "./sidebar-body";

/**
 * The mobile navigation drawer, plus the focus trap and scroll lock it needs.
 *
 * The trap lives here rather than in `Shell` so the shell component only owns
 * "is it open"; everything a keyboard needs to escape a modal is one file, which
 * is also the file a regression test would target.
 *
 * The drawer is always rendered and slides in both directions: hidden state is
 * `-translate-x-full` + `inert` + `aria-hidden`, which keeps it out of the tab
 * order and the accessibility tree while staying transitionable.
 */
export function MobileDrawer({
  open,
  onClose,
  context,
  displayName,
  displayEmail,
  showSignOut,
  showReset,
  triggerRef,
}: {
  open: boolean;
  onClose: () => void;
  context: ShellContextDto | null;
  displayName: string;
  displayEmail: string;
  showSignOut: boolean;
  showReset: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
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
        onClose();
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
    //
    // The reason for closing matters on the way out: the trigger lives inside
    // `md:hidden`, so handing focus back to it here would drop the focus ring
    // onto an element that is no longer displayed and strand a keyboard user at
    // the top of the document with nothing focused.
    let closedByViewport = false;
    const desktop = window.matchMedia("(min-width: 768px)");
    const handleViewportChange = (event: MediaQueryListEvent) => {
      if (event.matches) {
        closedByViewport = true;
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    desktop.addEventListener("change", handleViewportChange);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      desktop.removeEventListener("change", handleViewportChange);
      body.style.overflow = previousOverflow;

      if (closedByViewport) {
        // The desktop navigation is what took over, so the main region is the
        // honest landing spot: it is visible at this width and it is where the
        // person was heading.
        const main = document.getElementById("main");
        if (main) {
          main.focus();
          return;
        }
      }

      // Return focus to whatever opened the drawer (the trigger); fall back to
      // it explicitly when the remembered node is gone.
      const target =
        previousFocus instanceof HTMLElement && previousFocus.isConnected
          ? previousFocus
          : trigger;
      target?.focus();
    };
  }, [open, onClose, triggerRef]);

  return (
    <div className="md:hidden">
      <div
        aria-hidden="true"
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-40 bg-black/60 transition-opacity duration-200 motion-reduce:transition-none",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      <div
        id={DRAWER_ID}
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="导航菜单"
        aria-hidden={!open}
        inert={!open}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-[268px] flex-col border-r border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] shadow-[0_0_48px_-12px_rgba(0,0,0,0.85)] backdrop-blur-xl transition-transform duration-200 ease-out motion-reduce:transition-none",
          open ? "translate-x-0" : "-translate-x-full",
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
            onClick={onClose}
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
          onNavigate={onClose}
        />
      </div>
    </div>
  );
}
