import { describe, expect, it } from "vitest";

import { completionPercent, ratioToPercent } from "@/lib/presentation/ratio";

describe("ratioToPercent", () => {
  it("converts a 0-1 ratio to the 0-100 scale Progress reads", () => {
    expect(ratioToPercent(0.8)).toBe(80);
    expect(ratioToPercent(0.5)).toBe(50);
    expect(ratioToPercent(1)).toBe(100);
    expect(ratioToPercent(0)).toBe(0);
  });

  it("clamps instead of drawing outside the track", () => {
    expect(ratioToPercent(1.4)).toBe(100);
    expect(ratioToPercent(-0.2)).toBe(0);
  });

  it("returns 0 for values that are not numbers", () => {
    expect(ratioToPercent(Number.NaN)).toBe(0);
    expect(ratioToPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("completionPercent", () => {
  it("turns observed/required into a percentage", () => {
    // The bug this locks: the apprenticeship bar passed the raw 0-1 ratio to
    // Progress, so four of five observations rendered as 1%, and a full quota
    // never got past 1%.
    expect(completionPercent(4, 5)).toBe(80);
    expect(completionPercent(0, 5)).toBe(0);
    expect(completionPercent(5, 5)).toBe(100);
  });

  it("rounds to whole percentages", () => {
    expect(completionPercent(1, 3)).toBe(33);
    expect(completionPercent(2, 3)).toBe(67);
  });

  it("caps at 100 when more evidence than required was collected", () => {
    expect(completionPercent(7, 5)).toBe(100);
  });

  it("treats a zero requirement as nothing to draw, not as a division by zero", () => {
    expect(completionPercent(0, 0)).toBe(0);
    expect(completionPercent(3, 0)).toBe(0);
    expect(completionPercent(-1, 5)).toBe(0);
  });

  it("returns 0 for non-finite input", () => {
    expect(completionPercent(Number.NaN, 5)).toBe(0);
    expect(completionPercent(1, Number.NaN)).toBe(0);
  });
});
