/**
 * Focus policy for the confirmation dialog, kept out of the component so it can
 * be tested without a DOM. The repository runs its unit tests on `node` with no
 * jsdom, and the interesting failures here are about *decisions* — where focus
 * belongs and who moves it — not about rendering.
 *
 * Both rules below were established by measuring a real browser over CDP. The
 * comments record what was observed, because none of it is obvious from the
 * code and every naive version of these checks was wrong.
 */

/** Where focus currently sits, relative to the dialog. */
export type TrapPlacement =
  /** On one of the dialog's own focusable controls, by index. */
  | { zone: "control"; index: number }
  /** On the dialog shell itself — it is `tabIndex={-1}`, so focus can rest here. */
  | { zone: "surface" }
  /** Anywhere else: the page behind the modal, or `<body>`. */
  | { zone: "outside" };

export type TrapAction =
  /** Let the browser's native tab order run; it will stay inside the dialog. */
  | { kind: "allow" }
  /** Take over and move focus to a control. */
  | { kind: "focus"; index: number }
  /** Nothing focusable inside; fall back to the shell. */
  | { kind: "focus-surface" };

/**
 * What Tab (or Shift+Tab) should do.
 *
 * The wrap-around only fires when focus sits exactly on the first or last
 * control. A placement of `outside` gets pulled back in first — otherwise a
 * stray focus (backdrop click, programmatic focus, browser focus restoration
 * after a re-render) would tab through the page behind the modal. A placement
 * on the shell is deliberately allowed through: native tab order then moves
 * into the first control, which is what the user expects after focus is parked
 * there.
 */
export function planTab({
  placement,
  count,
  shiftKey,
}: {
  placement: TrapPlacement;
  count: number;
  shiftKey: boolean;
}): TrapAction {
  if (count <= 0) return { kind: "focus-surface" };

  const last = count - 1;

  if (placement.zone === "outside") {
    return { kind: "focus", index: shiftKey ? last : 0 };
  }

  if (placement.zone === "control") {
    if (shiftKey && placement.index === 0) return { kind: "focus", index: last };
    if (!shiftKey && placement.index === last) return { kind: "focus", index: 0 };
  }

  return { kind: "allow" };
}

export type BusyFocusAction =
  /** Move focus to the dialog shell. */
  | { kind: "focus-surface" }
  /** Leave focus alone. */
  | { kind: "allow" };

/**
 * What to do with focus when the confirm action starts running.
 *
 * React commits `disabled` on both buttons, and the browser then moves focus to
 * `<body>` — *after* the commit, on a later frame, which drops a screen reader
 * out of the modal exactly while it is announcing progress. Measured over CDP:
 * on the click frame the confirm button still reports itself as focused and
 * inside the dialog; from the next frame `<body>` does.
 *
 * So the surface is parked on unconditionally. Two tempting refinements are
 * both wrong:
 *   - "only if focus is outside the dialog" reads the pre-migration state and
 *     decides there is nothing to do, then watches focus fall to `<body>`;
 *   - deferring the move by one frame with `requestAnimationFrame` fires before
 *     the browser migrates focus, so it parks correctly and is then overridden.
 *
 * Parking unconditionally is also safe by construction: busy disables both
 * buttons, so the shell is the only place focus can go anyway.
 */
export function planBusyFocus({
  open,
  busy,
}: {
  open: boolean;
  busy: boolean;
}): BusyFocusAction {
  return open && busy ? { kind: "focus-surface" } : { kind: "allow" };
}
