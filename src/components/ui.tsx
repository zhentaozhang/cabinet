import { cn } from "@/lib/format";
import type { ReactNode } from "react";
import {
  Ban,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleHelp,
  CircleSlash,
  Clock,
  FlaskConical,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import {
  capabilityLabel,
  capabilityTone,
  statusLabel,
  statusTone,
  type BadgeTone,
  type CapabilityState,
} from "@/contracts/labels";

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
        // `flex-wrap` lets a wide `right` slot drop below the title instead of
        // pushing the card past the viewport. It only engages when the pair
        // genuinely does not fit, so ordinary headers still read as one line.
        "flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-4",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <div className="mb-1 text-label font-medium uppercase tracking-[0.16em] text-faint">
            {eyebrow}
          </div>
        ) : null}
        <div className="truncate text-emphasis font-semibold tracking-tight text-ink">{title}</div>
      </div>
      {right ? <div className="max-w-full shrink-0">{right}</div> : null}
    </div>
  );
}

/** Re-exported so callers can keep importing the tone type from this module. */
export type { BadgeTone };

const badgeTones: Record<BadgeTone, string> = {
  neutral: "border-line2/80 bg-panel2/80 text-muted shadow-sm",
  accent: "border-accent/40 bg-accent/15 text-accent shadow-[0_0_12px_-2px_rgba(226,163,54,0.18)]",
  teal: "border-teal/40 bg-teal/15 text-teal shadow-[0_0_12px_-2px_rgba(59,185,158,0.18)]",
  /* A tinted fill is still a background for the same red text, so 10% is
     the most it can take and stay above 4.5:1 on `panel-hover`. */
  danger: "border-danger/40 bg-danger/10 text-danger shadow-[0_0_12px_-2px_rgba(239,98,98,0.18)]",
  blue: "border-blue/40 bg-blue/15 text-blue shadow-[0_0_12px_-2px_rgba(91,159,248,0.18)]",
  violet: "border-violet/40 bg-violet/15 text-violet shadow-[0_0_12px_-2px_rgba(181,143,251,0.18)]",
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
    // Hover deepens the border, not the fill: a darker fill underneath the
    // same red text is what pushed this below 4.5:1.
    "border border-danger/40 bg-danger/10 text-danger hover:border-danger/70 hover:bg-danger/10",
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
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed",
        // Disabled controls are exempt from the 4.5:1 rule, but 45% opacity put
        // the label at 2.06:1 — present in the layout, unreadable in practice.
        // Flattening to a neutral surface keeps the same restraint while the
        // word stays legible. Variant fills are overridden, so `disabled:` wins.
        "disabled:border-line disabled:bg-panel2 disabled:text-muted disabled:shadow-none disabled:opacity-100",
        "outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        // `md` steps up in both height and type; `sm` stays at the 12px floor,
        // which is the smallest size CJK glyphs survive on this background.
        size === "sm" ? "h-7 px-2.5 text-label" : "h-9 px-3.5 text-body",
        buttonVariants[variant],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * A progress bar is a nameless graphic to a screen reader unless it is told
 * what it measures: "40%" alone is meaningless when the page has four bars.
 * Exactly one of `label` (when no visible heading exists) or `labelledBy`
 * (pointing at the visible heading) is required, so a new caller cannot forget.
 */
type ProgressName =
  | { label: string; labelledBy?: never }
  | { label?: never; labelledBy: string };

export function Progress({
  value,
  className,
  tone = "accent",
  ...name
}: {
  value: number;
  className?: string;
  tone?: "accent" | "teal" | "danger" | "blue";
} & ProgressName) {
  const tones = {
    accent: "bg-accent shadow-[0_0_8px_rgba(226,163,54,0.35)]",
    teal: "bg-teal shadow-[0_0_8px_rgba(59,185,158,0.35)]",
    danger: "bg-danger shadow-[0_0_8px_rgba(239,98,98,0.35)]",
    blue: "bg-blue shadow-[0_0_8px_rgba(91,159,248,0.35)]",
  };
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      role="progressbar"
      aria-label={"label" in name ? name.label : undefined}
      aria-labelledby={"labelledBy" in name ? name.labelledBy : undefined}
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
      <div className="mt-1 text-page font-semibold tracking-tight text-ink tabular-nums font-mono">
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

/**
 * A titled section.
 *
 * `as="h1"` is for the pages that have no other top-level heading — the three
 * settings screens used this as their page title while it rendered an `h2`,
 * which left them with no heading at all and broke the document outline for
 * screen readers. `h2` stays the default so existing sections keep their level.
 */
export function SectionTitle({
  eyebrow,
  title,
  hint,
  right,
  as: Heading = "h2",
}: {
  eyebrow?: string;
  title: string;
  hint?: string;
  right?: ReactNode;
  as?: "h1" | "h2";
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        {eyebrow ? (
          <div className="mb-1 text-label font-medium uppercase tracking-[0.16em] text-faint">
            {eyebrow}
          </div>
        ) : null}
        <Heading
          className={
            Heading === "h1"
              ? "text-page font-semibold tracking-tight text-ink"
              : "text-section font-semibold tracking-tight text-ink"
          }
        >
          {title}
        </Heading>
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
  tone = "neutral",
  icon,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  tone?: "neutral" | "danger";
  icon?: ReactNode;
}) {
  // `tone="neutral"` is the original markup, byte for byte — the three-prop
  // callers that already exist render exactly what they rendered before.
  if (tone === "neutral") {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 py-10 text-center">
        {icon ? <div className="mb-3 text-faint">{icon}</div> : null}
        <div className="text-emphasis text-muted">{title}</div>
        {hint ? <div className="mt-1 max-w-sm text-label text-faint">{hint}</div> : null}
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-danger/40 px-6 py-10 text-center">
      <div className="mb-3 text-danger">
        {icon ?? <TriangleAlert className="size-5" aria-hidden="true" />}
      </div>
      <div className="text-emphasis text-danger">{title}</div>
      {hint ? <div className="mt-1 max-w-sm text-label text-faint">{hint}</div> : null}
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

/* -------------------------------------------------------------------------
 * Status / empty / error / loading primitives
 *
 * Everything below is additive. The rule they all enforce is the same one:
 * a state is never communicated by colour alone. Each badge carries an icon
 * and a word, so it still reads in greyscale, to a colour-blind eye, and to a
 * screen reader.
 * ---------------------------------------------------------------------- */

const statusIcons: Record<BadgeTone, typeof Circle> = {
  teal: CheckCircle2,
  danger: TriangleAlert,
  accent: Clock,
  blue: Loader2,
  violet: CircleDashed,
  neutral: Circle,
};

/** The one way to render a workflow status. Text + icon, tone from labels.ts. */
export function StatusBadge({
  status,
  className,
  showIcon = true,
}: {
  status: string;
  className?: string;
  showIcon?: boolean;
}) {
  const tone = statusTone(status);
  const Icon = statusIcons[tone];
  return (
    <Badge tone={tone} className={className}>
      <span className="inline-flex items-center gap-1">
        {showIcon ? <Icon className="size-3" aria-hidden="true" /> : null}
        {statusLabel(status)}
      </span>
    </Badge>
  );
}

const capabilityIcons: Record<CapabilityState, typeof Circle> = {
  configured: CheckCircle2,
  not_configured: CircleSlash,
  simulated: FlaskConical,
  degraded: TriangleAlert,
  unavailable: Ban,
  unknown: CircleHelp,
};

/**
 * Deployment facts and provenance — wired or not, real or simulated.
 * `not_configured` is intentionally neutral rather than red; see labels.ts.
 */
export function CapabilityBadge({
  state,
  className,
}: {
  state: CapabilityState;
  className?: string;
}) {
  const Icon = capabilityIcons[state];
  return (
    <Badge tone={capabilityTone(state)} className={className}>
      <span className="inline-flex items-center gap-1">
        <Icon className="size-3" aria-hidden="true" />
        {capabilityLabel(state)}
      </span>
    </Badge>
  );
}

/**
 * A failure the user is expected to recover from.
 *
 * Three things every error surface owes the reader: what went wrong, whether
 * trying again can help, and what was *not* lost. `hint` exists so the caller
 * can make that last promise ("已保留你填写的内容") next to the retry button,
 * where it is actually read.
 */
export function ErrorState({
  title,
  description,
  hint,
  retry,
  retryLabel = "重试",
  className,
}: {
  title: string;
  description?: ReactNode;
  hint?: ReactNode;
  retry?: ReactNode;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "rounded-xl border border-danger/40 bg-danger/[0.06] px-5 py-4",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-emphasis font-semibold text-danger">{title}</div>
          {description ? (
            <div className="mt-1 text-label text-muted">{description}</div>
          ) : null}
          {hint ? <div className="mt-1 text-label text-faint">{hint}</div> : null}
        </div>
        {retry ? (
          <div className="shrink-0" aria-label={retryLabel}>
            {retry}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Loading placeholder whose shape approximates the content that replaces it,
 * so the page does not jump when data lands. Widths step down like real prose.
 */
export function LoadingBlock({
  rows = 3,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  const widths = ["100%", "92%", "84%"];
  return (
    <div
      aria-busy="true"
      role="status"
      className={cn("flex flex-col gap-2", className)}
    >
      <span className="sr-only">正在加载</span>
      {Array.from({ length: Math.max(1, rows) }, (_, i) => (
        <div
          key={i}
          className="h-4 animate-pulse rounded bg-panel2"
          style={{ width: widths[i % widths.length] }}
        />
      ))}
    </div>
  );
}
