"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/format";
import { FOCUS_RING } from "./nav";

/**
 * Wipes the demo workspace back to seed. Two steps rather than a dialog because
 * the confirmation must live where the button was — and because the destructive
 * action deserves a full-width red row, not a small `confirm()`.
 */
export function ResetButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "confirm" | "busy" | "error">(
    "idle",
  );

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
