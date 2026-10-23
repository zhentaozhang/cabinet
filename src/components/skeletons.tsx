import { cn } from "@/lib/format";
import { LoadingBlock } from "@/components/ui";

function Bar({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-md bg-white/[0.06]", className)} />
  );
}

/**
 * Route-level placeholder: keeps the shell stable while a page's data lands.
 *
 * The text lines come from `LoadingBlock` rather than local bars so the route
 * fallback and any in-page placeholder pulse at the same rhythm — two loading
 * languages on one screen reads as a glitch.
 */
export function PageSkeleton({
  title = "正在加载…",
  cards = 3,
  rail = true,
}: {
  title?: string;
  cards?: number;
  rail?: boolean;
}) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{title}</span>
      <div className={cn("grid gap-4", rail ? "lg:grid-cols-[1.65fr_1fr]" : "")}>
        <div className="space-y-4">
          <Bar className="h-6 w-40" />
          {Array.from({ length: cards }, (_, index) => (
            <div
              key={index}
              className="rounded-xl border border-line bg-panel/80 p-4"
            >
              <Bar className="mb-3 h-3 w-24" />
              <LoadingBlock rows={3} />
            </div>
          ))}
        </div>
        {rail ? (
          <div className="space-y-4">
            {Array.from({ length: 2 }, (_, index) => (
              <div
                key={index}
                className="rounded-xl border border-line bg-panel/80 p-4"
              >
                <Bar className="mb-3 h-3 w-20" />
                <LoadingBlock rows={2} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
