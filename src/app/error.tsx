"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-md rounded-xl border border-danger/25 bg-danger/[0.04] p-6">
        <div className="flex items-center gap-2 text-sm font-medium text-ink">
          <AlertTriangle className="size-4 text-danger" />
          这一页没有加载成功
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          {error.message || "未知错误"}。数据还在，重试不会丢失状态。
        </p>
        <button
          onClick={reset}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-line2 bg-panel2 px-3 py-1.5 text-[11px] text-ink hover:border-line2/80"
        >
          <RotateCcw className="size-3" />
          重试
        </button>
      </div>
    </div>
  );
}
