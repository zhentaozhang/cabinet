import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dateTime, shortDate, timeOnly } from "@/lib/format";

/**
 * `shortDate`/`dateTime`/`timeOnly` used to build a fresh
 * `Intl.DateTimeFormat` on every call, which is a known CPU hotspot (a single
 * task page renders 20+ timestamps). The formatter is now cached in module
 * state, so these tests drive the count of *constructions*: they swap
 * `Intl.DateTimeFormat` for a counting subclass and assert how many instances
 * the module actually built.
 *
 * The cache lives for the whole module lifetime, so every case below uses its
 * own time zone. A formatter built by an earlier case must never satisfy a
 * later assertion, otherwise the construction counts would be meaningless.
 */
const realDateTimeFormat = Intl.DateTimeFormat;
const SAMPLE = new Date("2026-10-22T16:30:00Z");

type Construction = {
  locale: string | undefined;
  options: Intl.DateTimeFormatOptions | undefined;
};

let constructions: Construction[] = [];

function countConstructions() {
  constructions = [];

  class CountingDateTimeFormat extends realDateTimeFormat {
    constructor(locale?: string | string[], options?: Intl.DateTimeFormatOptions) {
      super(locale, options);
      constructions.push({
        locale: Array.isArray(locale) ? locale[0] : locale,
        options,
      });
    }
  }

  Intl.DateTimeFormat = CountingDateTimeFormat as unknown as typeof Intl.DateTimeFormat;
}

function zones() {
  return constructions.map((entry) => entry.options?.timeZone);
}

describe("format: cached Intl.DateTimeFormat", () => {
  beforeEach(() => {
    countConstructions();
  });

  afterEach(() => {
    Intl.DateTimeFormat = realDateTimeFormat;
  });

  it("reuses a single formatter per format kind", () => {
    for (let i = 0; i < 25; i += 1) {
      shortDate(SAMPLE, "Asia/Tokyo");
      dateTime(SAMPLE, "Asia/Tokyo");
      timeOnly(SAMPLE, "Asia/Tokyo");
    }

    // One formatter per kind, not 75.
    expect(constructions).toHaveLength(3);
    expect(zones()).toEqual(["Asia/Tokyo", "Asia/Tokyo", "Asia/Tokyo"]);
    expect(constructions[0]?.locale).toBe("zh-CN");
  });

  it("keys the cache by time zone, so undefined and a named zone do not collide", () => {
    for (let i = 0; i < 5; i += 1) {
      shortDate(SAMPLE, "Europe/Paris");
      shortDate(SAMPLE);
    }

    // Two entries: the sentinel used for "undefined" must be distinct from a
    // real zone, otherwise the second call would reuse the first formatter.
    expect(constructions).toHaveLength(2);
    expect(zones()).toEqual(["Europe/Paris", undefined]);
  });

  it("alternates Asia/Shanghai and UTC without mixing zones", () => {
    for (let i = 0; i < 3; i += 1) {
      expect(shortDate(SAMPLE, "Asia/Shanghai")).toBe("10/23");
      expect(shortDate(SAMPLE, "UTC")).toBe("10/22");
      expect(dateTime(SAMPLE, "Asia/Shanghai")).toBe("10/23 00:30");
      expect(dateTime(SAMPLE, "UTC")).toBe("10/22 16:30");
      expect(timeOnly(SAMPLE, "Asia/Shanghai")).toBe("00:30");
      expect(timeOnly(SAMPLE, "UTC")).toBe("16:30");
    }

    // 3 kinds x 2 zones, reused across all 18 calls above.
    expect(constructions).toHaveLength(6);
  });

  it("keeps formatting ISO strings, not just Date objects", () => {
    expect(shortDate("2026-10-22T16:30:00Z", "UTC")).toBe("10/22");
    expect(shortDate("2026-10-22T16:30:00Z", "Asia/Shanghai")).toBe("10/23");
    expect(timeOnly("2026-10-22T16:30:00Z", "Asia/Shanghai")).toBe("00:30");
  });

  it("keeps the em dash for null and undefined", () => {
    expect(shortDate(null)).toBe("—");
    expect(shortDate(undefined)).toBe("—");
    expect(dateTime(null)).toBe("—");
    expect(dateTime(undefined)).toBe("—");
    expect(timeOnly(null)).toBe("—");
    expect(timeOnly(undefined)).toBe("—");
  });

  it("keeps throwing for unparsable dates (pre-existing behaviour)", () => {
    // `if (!value)` is the only guard in these helpers: a truthy but invalid
    // date reaches `Intl.DateTimeFormat#format` and throws. Caching the
    // formatter must not change that, and must not swallow the error.
    expect(() => shortDate("not-a-date")).toThrow(RangeError);
    expect(() => dateTime(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => timeOnly(new Date(Number.NaN))).toThrow(RangeError);
  });

  it("does not cache a formatter whose construction threw", () => {
    expect(() => shortDate(SAMPLE, "Not/AZone")).toThrow(RangeError);
    expect(constructions).toHaveLength(0);

    const expected = new realDateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      timeZone: "Australia/Sydney",
    }).format(SAMPLE);
    expect(shortDate(SAMPLE, "Australia/Sydney")).toBe(expected);
    expect(constructions).toHaveLength(1);
  });
});
