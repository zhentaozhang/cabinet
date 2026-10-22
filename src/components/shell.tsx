"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  Brain,
  ClipboardCheck,
  Gavel,
  LogOut,
  RefreshCw,
  Sun,
  Users,
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
];

const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

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

function NavLinks({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="主导航"
      className={cn("flex gap-1", compact ? "flex-row overflow-x-auto" : "flex-col")}
    >
      {NAV.map((item) => {
        const active =
          item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            aria-label={item.hint}
            className={cn(
              "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs transition-colors",
              FOCUS_RING,
              compact ? "shrink-0" : "",
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
            {!compact ? (
              <span
                aria-hidden="true"
                className="ml-auto hidden text-[10px] text-faint lg:block"
              >
                {active ? "●" : ""}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

function ResetButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");

  async function reset() {
    if (!window.confirm("重置会清空当前演示数据并重新播种，确认继续？")) return;
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

  return (
    <div>
      <button
        type="button"
        onClick={reset}
        disabled={state === "busy"}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[11px] transition-colors hover:bg-white/[0.04] disabled:opacity-50",
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
        <span className="text-[10px] uppercase tracking-[0.16em] text-faint">
          Autonomy
        </span>
        <span className="mono text-[10px] text-accent">L{highest}</span>
      </div>
      <div className="flex items-center gap-1">
        {[1, 2, 3].map((rung) => {
          const reached = (counts[rung - 1] ?? 0) > 0;
          return (
            <div key={rung} className="flex-1">
              <div
                className={cn("h-1 rounded-full", reached ? "bg-accent" : "bg-line2")}
              />
              <div className="mt-1 text-[9px] text-faint">L{rung}</div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-[10px] leading-relaxed text-muted">
        {context && context.agents > 0
          ? `${context.agents} 位在岗，L2+ ${autonomy.l2} 位`
          : "授权靠信用和审计，不靠信任。"}
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
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const sessionUser = session?.user;
  const displayName = sessionUser?.name ?? context?.name ?? "Zhen";
  const displayEmail = sessionUser?.email ?? context?.email ?? "demo workspace";
  const showSignOut = Boolean(sessionUser);
  const showReset = !sessionUser || sessionUser.email === "demo@cabinet.local";

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
            <div className="text-[13px] font-semibold tracking-[0.16em] text-ink">
              CABINET
            </div>
            <div className="text-[10px] tracking-wide text-faint">
              personal agent org
            </div>
          </div>
        </div>

        <div className="px-3">
          <NavLinks />
        </div>

        <div className="mt-auto border-t border-line p-3">
          <AutonomyPanel context={context} />

          <div className="mb-2 flex items-center gap-2 px-1">
            <div
              aria-hidden="true"
              className="flex size-6 items-center justify-center rounded-md border border-line2 bg-panel2 text-[10px] text-muted"
            >
              {displayName.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-medium text-ink">
                {displayName}
              </div>
              <div className="truncate text-[9px] text-faint">
                {displayEmail}
              </div>
            </div>
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
      </aside>

      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-xl md:hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          <Mark />
          <div className="text-[12px] font-semibold tracking-[0.16em]">CABINET</div>
        </div>
        <div className="px-3 pb-2">
          <NavLinks compact />
        </div>
      </header>

      <main id="main" className="md:ml-[232px]">
        <div className="mx-auto w-full max-w-[1180px] px-4 py-6 sm:px-6 md:px-8 md:py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
