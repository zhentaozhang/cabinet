import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Contrast is the one part of the palette that cannot be reviewed by looking at
 * a screenshot: a tone that fails reads as "a bit dim" rather than as a bug,
 * and it only gets worse as surfaces stack. This test derives the ratios from
 * `globals.css` itself so the numbers and the shipped colours cannot drift.
 */

const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

function token(name: string): string {
  const match = CSS.match(new RegExp(`--color-${name}:\\s*#([0-9a-fA-F]{6})`));
  if (!match) throw new Error(`globals.css has no --color-${name}`);
  return match[1].toLowerCase();
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Composite `over` at `alpha` onto `under`, the way `bg-x/10` actually renders. */
function tint(hex: string, alpha: number, under: string): string {
  const rgb = (h: string) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [f, u] = [rgb(hex), rgb(under)];
  return f
    .map((v, i) => Math.round(v * alpha + u[i] * (1 - alpha)))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}

// Every surface a reading-size paragraph can sit on.
const SURFACES = ["bg", "panel", "panel2", "panel-raised", "sunken", "panel-hover"] as const;
// The tones used for actual text. Decorative-only colours are excluded on
// purpose: a hairline is not read.
const TEXT_TONES = ["ink", "ink-soft", "muted", "faint", "accent", "teal", "blue", "violet", "danger"] as const;

describe("every text tone is readable on every surface", () => {
  // 4.5:1 is the WCAG AA floor for text below 18.66px bold / 24px regular, and
  // this UI has no text that large.
  it.each(TEXT_TONES)("--color-%s clears 4.5:1", (name) => {
    const foreground = token(name);
    for (const surface of SURFACES) {
      expect(
        contrast(foreground, token(surface)),
        `${name} on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the reading ladder ordered rather than collapsing it", () => {
    // If three of these review to the same shade the hierarchy is decorative
    // rather than structural, and the user cannot tell a hint from a heading.
    const ladder = ["faint", "muted", "ink-soft", "ink"].map((name) => contrast(token(name), token("panel")));
    for (let i = 1; i < ladder.length; i += 1) {
      expect(ladder[i], `step ${i} of faint → muted → ink-soft → ink`).toBeGreaterThan(ladder[i - 1]);
    }
  });
});

describe("a tone used as its own fill stays readable", () => {
  // `bg-danger/10 text-danger` is the shape of every error panel and destructive
  // button. The fill darkens the background the text sits on, so the flat ratio
  // above does not cover it — this is the case that actually failed before.
  const TINTED = [
    { tone: "danger", alpha: 0.1 },
    { tone: "accent", alpha: 0.15 },
    { tone: "teal", alpha: 0.15 },
    { tone: "blue", alpha: 0.15 },
    { tone: "violet", alpha: 0.15 },
  ] as const;

  it.each(TINTED)("$tone text on a $alpha fill", ({ tone, alpha }) => {
    const foreground = token(tone);
    for (const surface of SURFACES) {
      expect(
        contrast(foreground, tint(foreground, alpha, token(surface))),
        `${tone} on ${tone}/${alpha * 100}% over ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
