"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, Settings } from "lucide-react";
import type { ShellContextDto } from "@/contracts";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/format";
import { AutonomyPanel } from "./autonomy-panel";
import { FOCUS_RING } from "./nav";
import { NavLinks } from "./nav-links";
import { ResetButton } from "./reset-button";

/**
 * The body of the navigation surface: links, autonomy, account, reset. Desktop
 * renders it inside the fixed aside, mobile inside the drawer, so both show the
 * same information without duplicating the markup.
 */
export function SidebarBody({
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

      {/*
        The footer holds three different kinds of thing — org authority, the
        signed-in account, and a destructive demo action. Grouping them with
        spacing and one label each stops the reset button from reading like a
        fourth navigation item sitting next to the account name.
      */}
      <div className="mt-auto space-y-3 border-t border-line p-3">
        <AutonomyPanel context={context} />

        <div className="border-t border-line pt-3">
          <div className="mb-2 px-1 text-eyebrow tracking-[0.16em] text-faint uppercase">
            账户
          </div>
          <div className="flex items-center gap-2 px-1">
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
        </div>

        {showReset ? (
          <div className="border-t border-line pt-3">
            <ResetButton />
          </div>
        ) : null}
      </div>
    </div>
  );
}
