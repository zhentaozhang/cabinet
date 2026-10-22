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
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/format";

const NAV = [
  { href: "/", label: "Today", icon: Sun, hint: "每日闭环" },
  { href: "/cabinet", label: "Cabinet", icon: Users, hint: "组织与绩效" },
  { href: "/review", label: "Review", icon: ClipboardCheck, hint: "周复盘" },
  { href: "/memory", label: "Memory", icon: Brain, hint: "记忆与证据" },
  { href: "/council", label: "Council", icon: Gavel, hint: "内阁会议" },
];

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
    <nav className={cn("flex gap-1", compact ? "flex-row overflow-x-auto" : "flex-col")}>
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
            className={cn(
              "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs transition-colors",
              compact ? "shrink-0" : "",
              active
                ? "bg-white/[0.06] text-ink"
                : "text-muted hover:bg-white/[0.03] hover:text-ink",
            )}
          >
            <Icon
              className={cn(
                "size-4 shrink-0",
                active ? "text-accent" : "text-faint group-hover:text-muted",
              )}
            />
            <span className="font-medium">{item.label}</span>
            {!compact ? (
              <span className="ml-auto hidden text-[10px] text-faint lg:block">
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
  const [busy, setBusy] = useState(false);
  async function reset() {
    setBusy(true);
    try {
      await fetch("/api/demo/reset", { method: "POST" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      onClick={reset}
      disabled={busy}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-faint transition-colors hover:bg-white/[0.04] hover:text-muted disabled:opacity-50"
    >
      <RefreshCw className={cn("size-3", busy && "animate-spin")} />
      {busy ? "重置中…" : "重置演示数据"}
    </button>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const user = session?.user;
  const isDemo = !user || user.email === "demo@cabinet.local";
  const displayName = user?.name ?? "Zhen";
  const displayEmail = user?.email ?? "demo workspace";

  return (
    <div className="relative z-10 min-h-screen">
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
          <div className="mb-3 rounded-lg border border-line bg-panel2/60 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.16em] text-faint">
                Autonomy
              </span>
              <span className="text-[10px] text-accent">L1 → L3</span>
            </div>
            <div className="flex items-center gap-1">
              {[1, 2, 3].map((n) => (
                <div key={n} className="flex-1">
                  <div
                    className={cn(
                      "h-1 rounded-full",
                      n <= 2 ? "bg-accent" : "bg-line2",
                    )}
                  />
                  <div className="mt-1 text-[9px] text-faint">L{n}</div>
                </div>
              ))}
            </div>
            <div className="mt-2 text-[10px] leading-relaxed text-muted">
              授权靠信用和审计，不靠信任。
            </div>
          </div>

          <div className="mb-2 flex items-center gap-2 px-1">
            <div className="flex size-6 items-center justify-center rounded-md border border-line2 bg-panel2 text-[10px] text-muted">
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
            {user ? (
              <button
                onClick={async () => {
                  await authClient.signOut();
                  router.push("/login");
                  router.refresh();
                }}
                className="rounded p-1 text-faint hover:bg-white/[0.04] hover:text-muted"
                title="退出"
              >
                <LogOut className="size-3" />
              </button>
            ) : null}
          </div>
          {isDemo ? <ResetButton /> : null}
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

      <main className="md:ml-[232px]">
        <div className="mx-auto w-full max-w-[1180px] px-4 py-6 sm:px-6 md:px-8 md:py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
