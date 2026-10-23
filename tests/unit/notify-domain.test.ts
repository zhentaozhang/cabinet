import { describe, expect, it } from "vitest";

import {
  MAX_ATTEMPTS,
  isQuietHour,
  localHour,
  nextDeliveryAt,
  retryDelayMs,
} from "@/lib/domain/notify";

describe("quiet hours", () => {
  it("treats from === to as no quiet window", () => {
    expect(isQuietHour(3, 8, 8)).toBe(false);
    expect(isQuietHour(8, 8, 8)).toBe(false);
  });

  it("handles a window inside one day", () => {
    expect(isQuietHour(9, 8, 12)).toBe(true);
    expect(isQuietHour(8, 8, 12)).toBe(true);
    expect(isQuietHour(12, 8, 12)).toBe(false);
    expect(isQuietHour(7, 8, 12)).toBe(false);
  });

  it("wraps midnight", () => {
    expect(isQuietHour(23, 22, 8)).toBe(true);
    expect(isQuietHour(0, 22, 8)).toBe(true);
    expect(isQuietHour(7, 22, 8)).toBe(true);
    expect(isQuietHour(8, 22, 8)).toBe(false);
    expect(isQuietHour(12, 22, 8)).toBe(false);
  });

  it("reads the local hour in the user's zone", () => {
    // 2026-10-22T14:30Z = 22:30 in Shanghai, 07:30 in Los Angeles.
    const at = new Date("2026-10-22T14:30:00Z");
    expect(localHour(at, "Asia/Shanghai")).toBe(22);
    expect(localHour(at, "America/Los_Angeles")).toBe(7);
  });

  it("falls back to no quiet window for an unknown zone", () => {
    const at = new Date("2026-10-22T14:30:00Z");
    expect(localHour(at, "Mars/Olympus")).toBe(null);
    expect(nextDeliveryAt(at, "Mars/Olympus", 22, 8)).toEqual(at);
  });
});

describe("next delivery", () => {
  it("returns now when outside the quiet window", () => {
    const at = new Date("2026-10-22T02:00:00Z"); // 10:00 Shanghai
    expect(nextDeliveryAt(at, "Asia/Shanghai", 22, 8)).toEqual(at);
  });

  it("defers to the end of the window instead of dropping the message", () => {
    const at = new Date("2026-10-22T14:30:00Z"); // 22:30 Shanghai
    const next = nextDeliveryAt(at, "Asia/Shanghai", 22, 8);
    expect(localHour(next, "Asia/Shanghai")).toBe(8);
    expect(next.getTime()).toBeGreaterThan(at.getTime());
  });

  it("never defers more than a day", () => {
    const at = new Date("2026-10-22T14:30:00Z");
    const next = nextDeliveryAt(at, "Asia/Shanghai", 22, 8);
    expect(next.getTime() - at.getTime()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

describe("retry backoff", () => {
  it("grows then caps", () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(300_000);
    expect(retryDelayMs(3)).toBe(900_000);
    expect(retryDelayMs(4)).toBe(900_000);
    expect(retryDelayMs(99)).toBe(900_000);
  });

  it("gives up after a bounded number of attempts", () => {
    expect(MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(6);
  });
});
