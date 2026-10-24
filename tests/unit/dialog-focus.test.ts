import { describe, expect, it } from "vitest";

import { planBusyFocus, planTab, type TrapPlacement } from "@/lib/presentation/dialog-focus";

const control = (index: number): TrapPlacement => ({ zone: "control", index });
const SURFACE: TrapPlacement = { zone: "surface" };
const OUTSIDE: TrapPlacement = { zone: "outside" };

describe("planBusyFocus", () => {
  // Measured over CDP: disabling the confirm button moves focus to <body> on
  // the frame after the click. A check that reads the active element first sees
  // the still-focused button and does nothing, then focus is lost.
  it("parks on the surface whenever a running confirm has disabled the buttons", () => {
    expect(planBusyFocus({ open: true, busy: true })).toEqual({ kind: "focus-surface" });
  });

  it("leaves focus alone when the dialog is closed or idle", () => {
    expect(planBusyFocus({ open: false, busy: true })).toEqual({ kind: "allow" });
    expect(planBusyFocus({ open: true, busy: false })).toEqual({ kind: "allow" });
    expect(planBusyFocus({ open: false, busy: false })).toEqual({ kind: "allow" });
  });
});

describe("planTab keeps focus inside the modal", () => {
  it("lets native order move between interior controls", () => {
    expect(planTab({ placement: control(0), count: 2, shiftKey: false })).toEqual({ kind: "allow" });
    expect(planTab({ placement: control(1), count: 3, shiftKey: false })).toEqual({ kind: "allow" });
    expect(planTab({ placement: control(1), count: 3, shiftKey: true })).toEqual({ kind: "allow" });
  });

  it("wraps forward off the last control and backward off the first", () => {
    expect(planTab({ placement: control(1), count: 2, shiftKey: false })).toEqual({ kind: "focus", index: 0 });
    expect(planTab({ placement: control(0), count: 2, shiftKey: true })).toEqual({ kind: "focus", index: 1 });
  });

  // Without this, focus that escaped (backdrop click, browser restoring focus
  // after a re-render) would tab through the page behind the modal, because the
  // wrap checks only fire on the exact edge controls.
  it("pulls focus back in when it sits anywhere outside the dialog", () => {
    expect(planTab({ placement: OUTSIDE, count: 2, shiftKey: false })).toEqual({ kind: "focus", index: 0 });
    expect(planTab({ placement: OUTSIDE, count: 2, shiftKey: true })).toEqual({ kind: "focus", index: 1 });
  });

  it("falls back to the shell when the dialog has nothing focusable", () => {
    expect(planTab({ placement: control(0), count: 0, shiftKey: false })).toEqual({ kind: "focus-surface" });
    expect(planTab({ placement: OUTSIDE, count: 0, shiftKey: true })).toEqual({ kind: "focus-surface" });
  });

  // The shell is tabIndex={-1}: focus parked there should tab INTO the first
  // control, not be yanked to the last one, which is what a naive
  // "not a control" test would do.
  it("lets a shell placement fall through to native order", () => {
    expect(planTab({ placement: SURFACE, count: 2, shiftKey: false })).toEqual({ kind: "allow" });
    expect(planTab({ placement: SURFACE, count: 2, shiftKey: true })).toEqual({ kind: "allow" });
  });

  it("never returns an index outside the control list", () => {
    for (const count of [1, 2, 5]) {
      for (const placement of [OUTSIDE, SURFACE, control(0), control(count - 1)]) {
        for (const shiftKey of [false, true]) {
          const action = planTab({ placement, count, shiftKey });
          if (action.kind === "focus") {
            expect(action.index).toBeGreaterThanOrEqual(0);
            expect(action.index).toBeLessThan(count);
          }
        }
      }
    }
  });
});
