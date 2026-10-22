import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="mono text-mini uppercase tracking-[0.24em] text-faint">
        404 · not in the cabinet
      </div>
      <h1 className="mt-3 text-xl font-semibold tracking-tight text-ink">
        这个对象不在内阁里
      </h1>
      <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted">
        可能已被退休、删除，或者链接写错了。回到今日，从当前状态继续。
      </p>
      <Link
        href="/"
        className="mt-5 inline-flex items-center gap-1.5 rounded-md border border-line2 bg-panel2 px-3 py-1.5 text-micro text-ink hover:border-line2/80"
      >
        <ArrowLeft className="size-3" /> 返回今日
      </Link>
    </div>
  );
}
