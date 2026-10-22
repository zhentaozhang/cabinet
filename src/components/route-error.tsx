"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

/**
 * Shared body for every route-level error boundary. `error.tsx` files must be
 * client components, so the actual layout lives here instead of being copied
 * into each route.
 */
export function RouteError({
  error,
  reset,
  title = "这一页没有加载成功",
  hint = "数据还在，重试不会丢失状态。",
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
  hint?: string;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div
        role="alert"
        className="w-full max-w-md rounded-xl border border-danger/25 bg-danger/[0.04] p-6"
      >
        <div className="flex items-center gap-2 text-base font-medium text-ink">
          <AlertTriangle className="size-4 text-danger" />
          {title}
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {error.message || "未知错误"}。{hint}
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-line2 bg-panel2 px-3 py-1.5 text-micro text-ink transition-colors hover:border-line2/80 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
        >
          <RotateCcw className="size-3" />
          重试
        </button>
      </div>
    </div>
  );
}
