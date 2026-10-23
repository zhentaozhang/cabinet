"use client";

import Link from "next/link";
import { useEffect } from "react";
import { AlertTriangle, ArrowLeft, RotateCcw } from "lucide-react";

/** Exactly what Next 16 passes to an `error.tsx` default export. */
export type ErrorBoundaryProps = {
  error: Error & { digest?: string };
  reset: () => void;
  retry?: () => void;
};

/**
 * Shared body for every route-level error boundary.
 *
 * `error.tsx` files must be client components, so the layout lives here and each
 * segment only supplies its own title. `retry` re-fetches the segment on the
 * server while `reset` only clears the error state — when a page's *data* failed,
 * reset alone re-renders the same failed render, so `retry` wins when provided.
 */
export function ErrorPanel({
  error,
  reset,
  retry,
  title = "这一页没有加载成功",
  hint = "数据还在，重试不会丢失状态。",
}: ErrorBoundaryProps & { title?: string; hint?: string }) {
  useEffect(() => {
    // The console keeps the full stack trace; the panel below never renders it.
    console.error(error);
  }, [error]);

  const message =
    typeof error?.message === "string" && error.message ? error.message : "未知错误";
  const recover = retry ?? reset;
  const actionClass =
    "inline-flex items-center gap-1.5 rounded-md border border-line2 bg-panel2 px-3 py-1.5 text-label text-ink transition-colors hover:border-line2/80 hover:bg-panel-hover focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none";

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div
        role="alert"
        className="w-full max-w-md rounded-xl border border-danger/25 bg-danger/[0.04] p-6"
      >
        <div className="flex items-center gap-2 text-title font-medium text-ink">
          <AlertTriangle className="size-4 shrink-0 text-danger" aria-hidden />
          {title}
        </div>
        <p className="mt-2 text-body leading-relaxed text-muted">
          {message}。{hint}
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-label text-muted/70">
            错误编号 {error.digest}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => recover()} className={actionClass}>
            <RotateCcw className="size-3" aria-hidden />
            重试
          </button>
          <Link href="/" className={actionClass}>
            <ArrowLeft className="size-3" aria-hidden />
            回到 Today
          </Link>
        </div>
      </div>
    </div>
  );
}
