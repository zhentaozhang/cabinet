import { cn } from "@/lib/format";
import type { ReactNode } from "react";

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative rounded-xl border border-line bg-panel/80 backdrop-blur-[2px]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  eyebrow,
  right,
  className,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-b border-line px-5 py-4",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.18em] text-faint">
            {eyebrow}
          </div>
        ) : null}
        <div className="truncate text-sm font-medium text-ink">{title}</div>
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

type BadgeTone = "neutral" | "accent" | "teal" | "danger" | "blue" | "violet";

const badgeTones: Record<BadgeTone, string> = {
  neutral: "border-line2 bg-panel2 text-muted",
  accent: "border-accent/30 bg-accent/10 text-accent",
  teal: "border-teal/30 bg-teal/10 text-teal",
  danger: "border-danger/30 bg-danger/10 text-danger",
  blue: "border-blue/30 bg-blue/10 text-blue",
  violet: "border-violet/30 bg-violet/10 text-violet",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium tracking-wide",
        badgeTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

type ButtonVariant = "primary" | "outline" | "ghost" | "danger";

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-[#1a1204] hover:bg-[#efb954] border border-accent/60",
  outline:
    "border border-line2 bg-panel2 text-ink hover:border-line2/80 hover:bg-[#1a2030]",
  ghost: "text-muted hover:text-ink hover:bg-white/[0.04] border border-transparent",
  danger:
    "border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20",
};

export function Button({
  children,
  variant = "outline",
  size = "md",
  className,
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        "outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        size === "sm" ? "h-7 px-2.5 text-[11px]" : "h-9 px-3.5 text-xs",
        buttonVariants[variant],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Progress({
  value,
  className,
  tone = "accent",
}: {
  value: number;
  className?: string;
  tone?: "accent" | "teal" | "danger" | "blue";
}) {
  const tones = {
    accent: "bg-accent",
    teal: "bg-teal",
    danger: "bg-danger",
    blue: "bg-blue",
  };
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-line", className)}
    >
      <div
        className={cn("h-full rounded-full transition-all", tones[tone])}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
        {label}
      </div>
      <div className="mt-1.5 text-lg font-semibold tracking-tight text-ink tabular-nums">
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted">{hint}</div> : null}
    </div>
  );
}

export function Avatar({
  initials,
  accent = "#e0a83e",
  size = 36,
  className,
}: {
  initials: string;
  accent?: string;
  size?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg border font-mono text-[11px] font-semibold",
        className,
      )}
      style={{
        width: size,
        height: size,
        color: accent,
        borderColor: `${accent}55`,
        background: `${accent}14`,
      }}
    >
      {initials}
    </div>
  );
}

export function SectionTitle({
  eyebrow,
  title,
  hint,
  right,
}: {
  eyebrow?: string;
  title: string;
  hint?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        {eyebrow ? (
          <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-faint">
            {eyebrow}
          </div>
        ) : null}
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 py-10 text-center">
      <div className="text-sm text-muted">{title}</div>
      {hint ? <div className="mt-1 max-w-sm text-xs text-faint">{hint}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Dot({ tone = "teal" }: { tone?: "teal" | "accent" | "danger" | "muted" }) {
  const tones = {
    teal: "bg-teal",
    accent: "bg-accent",
    danger: "bg-danger",
    muted: "bg-faint",
  };
  return <span className={cn("inline-block size-1.5 rounded-full", tones[tone])} />;
}
