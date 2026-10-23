import type { ShellContextDto } from "@/contracts";
import { cn } from "@/lib/format";

/**
 * How much autonomy the org currently holds, as three rungs. A rung lights when
 * at least one agent sits on it, so the panel answers "where is authority now"
 * rather than "how many agents exist".
 */
export function AutonomyPanel({ context }: { context: ShellContextDto | null }) {
  const autonomy = context?.autonomy ?? { l1: 0, l2: 0, l3: 0 };
  const counts = [autonomy.l1, autonomy.l2, autonomy.l3];
  const highest = counts.reduce(
    (acc, count, index) => (count > 0 ? index + 1 : acc),
    0,
  );

  return (
    // No bottom margin: the sidebar footer spaces its children with `space-y-3`,
    // and a local margin here doubled that gap to 24px.
    <div className="rounded-lg border border-line bg-panel2/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-eyebrow uppercase tracking-[0.16em] text-faint">
          Autonomy
        </span>
        <span className="mono text-label text-accent">L{highest}</span>
      </div>
      <div className="flex items-center gap-1">
        {[1, 2, 3].map((rung) => {
          const reached = (counts[rung - 1] ?? 0) > 0;
          return (
            <div key={rung} className="flex-1">
              <div
                className={cn(
                  "h-1 rounded-full",
                  reached ? "bg-accent" : "bg-line2",
                )}
              />
              <div className="mt-1 text-label text-faint">L{rung}</div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-label leading-relaxed text-muted">
        {context && context.agents > 0
          ? `${context.agents} 位在岗，L2+ ${autonomy.l2} 位`
          : "授权靠信用和审计，不靠信任。"}
      </div>
    </div>
  );
}
