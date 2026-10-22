import { cn } from "@/lib/format";
import type { ReactNode } from "react";

export type CardVariant = "default" | "elevated" | "decision" | "ghost";

const cardVariants: Record<CardVariant, string> = {
  default:
    "relative rounded-xl border border-line bg-panel/85 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05),0_8px_24px_-4px_rgba(0,0,0,0.45)] backdrop-blur-md",
  elevated:
    "relative rounded-xl border border-line2/80 bg-panel-raised/90 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),0_12px_32px_-4px_rgba(0,0,0,0.55)] backdrop-blur-md",
  decision:
    "relative rounded-xl decision-halo bg-panel/90 backdrop-blur-md",
  ghost:
    "relative rounded-xl border border-dashed border-line bg-transparent",
};

export function Card({
  children,
  className,
  variant = "default",
}: {
  children: ReactNode;
  className?: string;
  variant?: CardVariant;
}) {
  return (
    <div className={cn(cardVariants[variant], className)}>
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
          <div className="mb-1 text-label font-medium uppercase tracking-[0.16em] text-faint">
            {eyebrow}
          </div>
        ) : null}
        <div className="truncate text-sm font-semibold tracking-tight text-ink">{title}</div>
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

type BadgeTone = "neutral" | "accent" | "teal" | "danger" | "blue" | "violet";

const badgeTones: Record<BadgeTone, string> = {
  neutral: "border-line2/80 bg-panel2/80 text-muted shadow-sm",
  accent: "border-accent/40 bg-accent/15 text-accent shadow-[0_0_12px_-2px_rgba(226,163,54,0.18)]",
  teal: "border-teal/40 bg-teal/15 text-teal shadow-[0_0_12px_-2px_rgba(59,185,158,0.18)]",
  danger: "border-danger/40 bg-danger/15 text-danger shadow-[0_0_12px_-2px_rgba(234,85,85,0.18)]",
  blue: "border-blue/40 bg-blue/15 text-blue shadow-[0_0_12px_-2px_rgba(91,159,248,0.18)]",
  violet: "border-violet/40 bg-violet/15 text-violet shadow-[0_0_12px_-2px_rgba(163,113,247,0.18)]",
};

export function Badge({
  children,
  tone = "neutral",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-label font-medium tracking-wide transition-colors",
        badgeTones[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

type ButtonVariant = "primary" | "outline" | "ghost" | "danger";

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-ink hover:bg-accent-hi border border-accent/60",
  outline:
    "border border-line2 bg-panel2 text-ink hover:border-line2/80 hover:bg-panel-hover",
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
        size === "sm" ? "h-7 px-2.5 text-label" : "h-9 px-3.5 text-xs",
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
    accent: "bg-accent shadow-[0_0_8px_rgba(226,163,54,0.35)]",
    teal: "bg-teal shadow-[0_0_8px_rgba(59,185,158,0.35)]",
    danger: "bg-danger shadow-[0_0_8px_rgba(234,85,85,0.35)]",
    blue: "bg-blue shadow-[0_0_8px_rgba(91,159,248,0.35)]",
  };
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-line/80", className)}
    >
      <div
        className={cn("h-full rounded-full transition-all duration-500 ease-out", tones[tone])}
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
      <div className="text-label font-medium uppercase tracking-[0.14em] text-faint">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-ink tabular-nums font-mono">
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-body text-muted">{hint}</div> : null}
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
        "flex shrink-0 items-center justify-center rounded-lg border font-mono text-label font-semibold shadow-sm transition-transform duration-200 hover:scale-105",
        className,
      )}
      style={{
        width: size,
        height: size,
        color: accent,
        borderColor: `${accent}40`,
        background: `radial-gradient(circle at 30% 30%, ${accent}24, ${accent}08)`,
        boxShadow: `0 0 12px -3px ${accent}25`,
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
          <div className="mb-1 text-label font-medium uppercase tracking-[0.16em] text-faint">
            {eyebrow}
          </div>
        ) : null}
        <h2 className="text-base font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {hint ? <p className="mt-1 text-body text-muted">{hint}</p> : null}
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
