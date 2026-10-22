import { cn } from "@/lib/format";

function Bar({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-md bg-white/[0.06]", className)} />
  );
}

/** Route-level placeholder: keeps the shell stable while a page's data lands. */
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
              <Bar className="mb-2 h-2.5 w-full" />
              <Bar className="mb-2 h-2.5 w-5/6" />
              <Bar className="h-2.5 w-2/3" />
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
                <Bar className="mb-2 h-2.5 w-full" />
                <Bar className="h-2.5 w-4/5" />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
